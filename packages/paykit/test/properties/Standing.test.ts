import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { allowance, grant, type Allowance, type Allowances } from "../../src/Allowance.ts";
import { feature, type Feature } from "../../src/Feature.ts";
import { activationOf, standingFrom, type StandingGrant } from "../../src/Subscription/Standing.ts";
import {
  initialSubscriptionState,
  SubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const features = {
  messages: feature({ id: "messages", name: "Messages" }),
  seats: feature({ id: "seats", name: "Seats" }),
  ai: feature({ id: "ai", name: "AI", creditRates: { default: 1 } }),
  sso: feature({ id: "sso", name: "SSO", kind: "flag" }),
} satisfies Record<string, Feature>;

type FeatureKey = keyof typeof features;

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  Schema.Literal("unlimited"),
]);

const UnitPriceSpec = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  currency: Schema.Literals(["usd", "eur"]),
});

const GrantSpec = Schema.Struct({
  feature: Schema.Literals(["messages", "seats", "ai", "sso"]),
  kind: Schema.Literals(["metered", "flag"]),
  included: IncludedSpec,
  overage: Schema.Literals(["block", "bill", "allow"]),
  resets: Schema.Literals(["month", "annual", "never"]),
  carryOver: Schema.Boolean,
  unitPrice: Schema.optionalKey(UnitPriceSpec),
  moneyCap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_000 }))),
  ),
});
type GrantSpec = typeof GrantSpec.Type;

const CreditRatesSpec = Schema.Struct({
  default: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  "gpt-large": Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
});

const PriceSpec = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))),
  currency: Schema.Literals(["usd", "eur"]),
  interval: Schema.Literals(["month", "annual"]),
});

const ActivationCase = Schema.Struct({
  grants: Schema.Array(GrantSpec).pipe(Schema.check(Schema.isMaxLength(4))),
  credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
  prepaid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
  creditsExpire: Schema.Literals(["period", "never"]),
  topUp: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5_000 }))),
  ),
  rates: Schema.optionalKey(CreditRatesSpec),
  price: Schema.optionalKey(PriceSpec),
  previousCurrency: Schema.optionalKey(Schema.Literals(["usd", "eur"])),
  status: Schema.Literals(["active", "trialing"]),
  interval: Schema.optionalKey(Schema.Literals(["month", "annual"])),
  periodDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 120 }))),
  anchorTz: Schema.Literals(["UTC", "America/New_York"]),
  previous: Schema.Literals(["empty", "subscribed"]),
  trialUsed: Schema.Boolean,
});
type ActivationCase = typeof ActivationCase.Type;

const allowanceOf = (spec: GrantSpec): Allowance => {
  if (spec.kind === "flag") return grant(features[spec.feature]);
  const unitPrice =
    spec.included === "unlimited" || spec.unitPrice === undefined ? undefined : spec.unitPrice;
  return allowance(features[spec.feature], {
    included: spec.included,
    overage: spec.included === "unlimited" ? "allow" : unitPrice === undefined ? "block" : "bill",
    resets: spec.resets,
    carryOver: spec.carryOver && spec.resets !== "never",
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(unitPrice === undefined || spec.moneyCap === undefined ? {} : { moneyCap: spec.moneyCap }),
  });
};

/** A record keyed by feature, so a duplicate declaration cannot hide a grant. */
const allowancesOf = (specs: ReadonlyArray<GrantSpec>): Allowances => {
  const entries = specs.map((spec) => [spec.feature, allowanceOf(spec)] as const);
  const unique = new Map<FeatureKey, Allowance>(entries);
  if (unique.size === 0) unique.set("messages", allowance(features.messages, { included: 100 }));
  return Object.fromEntries(unique) as Allowances;
};

const includedRemaining = (allowance: Allowance): number | null =>
  allowance.kind === "flag" || allowance.included === "unlimited" ? null : allowance.included;

const previousOf = (kind: ActivationCase["previous"]): SubscriptionState => {
  const refs = { stripe: { customer: "cus_previous" } };
  if (kind === "empty") return { ...initialSubscriptionState, refs };
  const terms = allowancesOf([]);
  const previousGrant = activationOf({
    tier: "prior",
    allowances: terms,
    credits: 500,
    creditsExpire: "period",
    rates: {},
    price: { amount: 1_900, currency: "eur", interval: "annual" },
    period: { start, end: DateTime.add(start, { days: 30 }), anchorTz: "UTC" },
    statusAfter: "active",
  });
  return {
    ...standingFrom(
      { ...previousGrant, interval: "annual" },
      { ...initialSubscriptionState, refs },
      { trialUsed: false },
    ),
    refs,
    // A standing that has lived a while: an activation is a fresh standing and
    // must not carry any of these into the new one.
    cancelAtPeriodEnd: true,
    graceUntil: start,
    trialEndsAt: start,
    pendingTier: {
      tier: "pending",
      allowances: {},
      credits: 1,
      creditsExpire: "period",
      rates: {},
    },
    proration: { currency: "usd", credit: 1, charge: 3, due: 2 },
    prorationInvoice: "in_previous",
    prorationId: "proration_previous",
    prorationSeq: 1,
    lastClosedPeriodStart: start,
  } satisfies SubscribedState;
};

const stateOf = (state: SubscriptionState): SubscribedState => {
  if (state._tag !== "Subscribed") throw new Error("the activation did not open a standing");
  return state;
};

/**
 * JSON with object keys sorted. A decoded state is the same state as the one
 * that was encoded even when the schema assembles its fields in another order.
 */
const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

describe("activationOf", () => {
  /**
   * An activation is the one place a grant is written down. The pack part is
   * clamped to the pool (`activationOf` is the clamp), the currency falls back
   * price → unit price → the currency the account already had, and every count
   * starts at what its allowance includes. A field that disagrees here becomes
   * a standing that cannot be reproduced from its own event.
   */
  it.effect("records the grant, clamps the pack part and resolves the currency", () =>
    assertProperty(
      Arbitrary.schema(ActivationCase),
      (input) => {
        const allowances = allowancesOf(input.grants);
        const period = {
          start,
          end: DateTime.add(start, { days: input.periodDays }),
          anchorTz: input.anchorTz,
        };
        const grant = activationOf({
          tier: "pro",
          allowances,
          credits: input.credits,
          prepaidCredits: input.prepaid,
          creditsExpire: input.creditsExpire,
          ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
          rates: input.rates === undefined ? {} : { ai: input.rates },
          ...(input.price === undefined ? {} : { price: input.price }),
          period,
          ...(input.previousCurrency === undefined
            ? {}
            : { previousCurrency: input.previousCurrency }),
          statusAfter: input.status,
        });

        const prepaid = Math.min(input.prepaid, input.credits);
        if (grant.credits !== input.credits) return false;
        if (prepaid === 0) {
          if (grant.prepaidCredits !== undefined) return false;
        } else if (grant.prepaidCredits !== prepaid) {
          return false;
        }
        if (grant.tier !== "pro") return false;
        if (grant.statusAfter !== input.status) return false;
        if (grant.creditsExpire !== input.creditsExpire) return false;
        if (grant.topUp !== input.topUp) return false;
        if (grant.periodStart !== period.start || grant.periodEnd !== period.end) return false;
        if (grant.anchorTz !== period.anchorTz) return false;
        if (JSON.stringify(grant.price) !== JSON.stringify(input.price)) return false;

        const expectedRemaining = Object.fromEntries(
          Object.entries(allowances).map(([feature, value]) => [feature, includedRemaining(value)]),
        );
        if (JSON.stringify(grant.remaining) !== JSON.stringify(expectedRemaining)) return false;

        const firstUnitPrice = Object.values(allowances).find(
          (value) => value.unitPrice !== undefined,
        )?.unitPrice?.currency;
        const expectedCurrency = input.price?.currency ?? firstUnitPrice ?? input.previousCurrency;
        if (grant.currency !== expectedCurrency) return false;

        return true;
      },
      { runs: 200, size: 40 },
    ),
  );
});

describe("standingFrom", () => {
  /**
   * A fresh activation opens a fresh standing: the grant's counts and terms,
   * the references and trial flag the account already had, and none of the
   * previous standing's money, pending change or dunning. The prepaid part is
   * a part of the pool — `0 <= prepaidCredits <= credits` — which is what lets
   * a close protect it.
   */
  it.effect("opens a fresh standing from the grant, preserving only refs and the trial flag", () =>
    assertProperty(
      Arbitrary.schema(ActivationCase),
      (input) => {
        const allowances = allowancesOf(input.grants);
        const period = {
          start,
          end: DateTime.add(start, { days: input.periodDays }),
          anchorTz: input.anchorTz,
        };
        const previous = previousOf(input.previous);
        const activation = activationOf({
          tier: "pro",
          allowances,
          credits: input.credits,
          prepaidCredits: input.prepaid,
          creditsExpire: input.creditsExpire,
          ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
          rates: input.rates === undefined ? {} : { ai: input.rates },
          ...(input.price === undefined ? {} : { price: input.price }),
          period,
          ...(input.previousCurrency === undefined
            ? {}
            : { previousCurrency: input.previousCurrency }),
          statusAfter: input.status,
        });
        const grant: StandingGrant = {
          ...activation,
          ...(input.interval === undefined ? {} : { interval: input.interval }),
          ...(input.status === "trialing" ? { trialEndsAt: period.end } : {}),
        };
        const state = stateOf(standingFrom(grant, previous, { trialUsed: input.trialUsed }));

        if (state.tier !== "pro") return false;
        if (state.status !== input.status) return false;
        if (state.period.start !== period.start || state.period.end !== period.end) return false;
        if (state.period.anchorTz !== period.anchorTz) return false;
        if (state.credits !== activation.credits) return false;
        if (JSON.stringify(state.allowances) !== JSON.stringify(activation.allowances))
          return false;
        if (JSON.stringify(state.remaining) !== JSON.stringify(activation.remaining)) return false;
        if (state.creditsExpire !== activation.creditsExpire) return false;
        if (state.topUp !== activation.topUp) return false;
        if (JSON.stringify(state.rates) !== JSON.stringify(activation.rates)) return false;
        if (JSON.stringify(state.price) !== JSON.stringify(activation.price)) return false;

        // The pack part is inside the pool, and omitted only when there is
        // none to protect. A state that says otherwise makes expiry arithmetic
        // subtract more than the account ever bought.
        const prepaid = state.prepaidCredits ?? 0;
        if (prepaid !== (activation.prepaidCredits ?? 0)) return false;
        if (prepaid < 0 || prepaid > state.credits) return false;

        if (state.interval !== (input.interval ?? activation.price?.interval ?? "month")) {
          return false;
        }
        if (state.trialUsed !== input.trialUsed) return false;
        if (JSON.stringify(state.refs) !== JSON.stringify(previous.refs)) return false;

        // Everything a standing accumulates starts empty on a new one.
        if (Object.keys(state.usage).length !== 0) return false;
        if (Object.keys(state.holds).length !== 0) return false;
        if (Object.keys(state.dedupeKeys).length !== 0) return false;
        if (state.dunningAttempts !== 0) return false;
        if (state.cancelAtPeriodEnd !== false) return false;
        for (const field of [
          "graceUntil",
          "pendingTier",
          "proration",
          "prorationInvoice",
          "prorationId",
          "prorationSeq",
          "lastClosedPeriodStart",
        ] as const) {
          if (field in state) return false;
        }
        return true;
      },
      { runs: 200, size: 40 },
    ),
  );

  it.effect("a state built from an activation decodes as the state it is", () =>
    assertProperty(
      Arbitrary.schema(ActivationCase),
      (input) => {
        const allowances = allowancesOf(input.grants);
        const period = {
          start,
          end: DateTime.add(start, { days: input.periodDays }),
          anchorTz: input.anchorTz,
        };
        const activation = activationOf({
          tier: "pro",
          allowances,
          credits: input.credits,
          prepaidCredits: input.prepaid,
          creditsExpire: input.creditsExpire,
          ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
          rates: input.rates === undefined ? {} : { ai: input.rates },
          ...(input.price === undefined ? {} : { price: input.price }),
          period,
          ...(input.previousCurrency === undefined
            ? {}
            : { previousCurrency: input.previousCurrency }),
          statusAfter: input.status,
        });
        const state = stateOf(
          standingFrom(
            {
              ...activation,
              ...(input.interval === undefined ? {} : { interval: input.interval }),
              ...(input.status === "trialing" ? { trialEndsAt: period.end } : {}),
            },
            previousOf(input.previous),
            { trialUsed: input.trialUsed },
          ),
        );
        // What an activation records is what a replay decodes: a state the
        // schema cannot read back is a state the next deploy cannot load.
        const decoded = Schema.decodeSync(SubscriptionState)(
          Schema.encodeSync(SubscriptionState)(state),
        );
        return canonicalJson(decoded) === canonicalJson(state);
      },
      { runs: 60, size: 20 },
    ),
  );
});
