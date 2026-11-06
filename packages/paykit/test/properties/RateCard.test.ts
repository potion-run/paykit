import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { catalog, ratesOf, tierTermsOf } from "../../src/Catalog.ts";
import {
  cardFromRates,
  creditRateOf,
  feature,
  messages,
  rateCard,
  type RateCard,
} from "../../src/Feature.ts";
import { prorate } from "../../src/Proration.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { Hold, UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { SettleHold, UsageSettled } from "../../src/Subscription/SettleHold.command.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedIn } from "./Arbitraries.ts";

const Rate = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 })));
const Factor = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0.1, maximum: 3 })));
const Add = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10, maximum: 10 })));
const Size = Schema.Literals(["small", "large"]);
const Lifecycle = Schema.Literals(["spot", "on_demand"]);

/** What a caller says about an event: a dimension, properties, or both. */
const Ask = Schema.Struct({
  dimension: Schema.optionalKey(Schema.Literals(["gpt-large", "embed"])),
  size: Schema.optionalKey(Size),
  lifecycle: Schema.optionalKey(Lifecycle),
});
type Ask = typeof Ask.Type;

const propertiesOf = (ask: Ask): Readonly<Record<string, string>> => ({
  ...(ask.size === undefined ? {} : { size: ask.size }),
  ...(ask.lifecycle === undefined ? {} : { lifecycle: ask.lifecycle }),
});

const askOf = (ask: Ask) => ({
  ...(ask.dimension === undefined ? {} : { dimension: ask.dimension }),
  properties: propertiesOf(ask),
});

const matches = (
  match: Readonly<Record<string, string>>,
  properties: Readonly<Record<string, string>>,
): boolean => Object.entries(match).every(([key, value]) => properties[key] === value);

describe("a rate card prices on the event, not on a name", () => {
  /**
   * The precedence ADR 0022 states: a matching rule beats the named dimension,
   * which beats the default; every matching multiplier then applies
   * (`rate × factors + adds`), and the result never goes below zero. The
   * expected value is computed from the author's declaration, not from the card
   * the compiler built.
   */
  it.effect("takes the first matching rule, then the dimension, then the default", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          fallback: Rate,
          large: Rate,
          dimension: Rate,
          factor: Factor,
          add: Add,
          ask: Ask,
        }),
      ),
      ({ fallback, large, dimension, factor, add, ask }) => {
        const card = rateCard({
          default: fallback,
          dimensions: { "gpt-large": dimension },
          rules: [{ match: { size: "large" }, credits: large }],
          multipliers: [{ match: { lifecycle: "spot" }, factor, add }],
        });
        const properties = propertiesOf(ask);
        const named = ask.dimension === "gpt-large" ? dimension : fallback;
        const chosen = matches({ size: "large" }, properties) ? large : named;
        const adjusted = matches({ lifecycle: "spot" }, properties)
          ? chosen * factor + add
          : chosen;
        const expected = Math.max(0, Math.round(adjusted));

        if (creditRateOf(card, askOf(ask)) !== expected) return false;
        // A multiplier is a change, not a replacement: a card with none prices
        // the same event at the base rate.
        const plain = rateCard({ default: fallback, dimensions: { "gpt-large": dimension } });
        return creditRateOf(plain, askOf(ask)) === Math.max(0, Math.round(named));
      },
      { runs: 120, size: 30 },
    ),
  );

  it("lets a matching rule beat a named dimension, and the first rule win", () => {
    const card = rateCard({
      default: 1,
      dimensions: { "gpt-large": 5 },
      rules: [
        { match: { size: "large" }, credits: 16 },
        { match: { size: "large", lifecycle: "spot" }, credits: 100 },
      ],
    });
    expect(creditRateOf(card, { dimension: "gpt-large", properties: { size: "large" } })).toBe(16);
    expect(creditRateOf(card, { properties: { size: "small" } })).toBe(1);
    expect(creditRateOf(card, { dimension: "gpt-large", properties: { size: "small" } })).toBe(5);
    expect(creditRateOf(card, {})).toBe(1);
  });

  it("applies every matching multiplier in order and clamps at zero", () => {
    const card = rateCard({
      default: 10,
      multipliers: [
        { match: { lifecycle: "spot" }, factor: 0.3 },
        { match: { lifecycle: "spot" }, add: -100 },
      ],
    });
    expect(creditRateOf(card, { properties: { lifecycle: "spot" } })).toBe(0);
    expect(creditRateOf(card, { properties: { lifecycle: "on_demand" } })).toBe(10);
    // No properties means no match at all, even for an empty rule.
    expect(creditRateOf(card)).toBe(10);
  });

  it.effect("compiles the shorthand into one dimension per rate", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          fallback: Rate,
          alpha: Rate,
          beta: Rate,
        }),
      ),
      ({ fallback, alpha, beta }) => {
        const rates = { default: fallback, alpha, beta };
        const card = cardFromRates(rates);
        return (
          creditRateOf(card, { dimension: "alpha" }) === alpha &&
          creditRateOf(card, { dimension: "beta" }) === beta &&
          creditRateOf(card, { dimension: "unknown" }) === fallback &&
          creditRateOf(card) === fallback
        );
      },
      { runs: 100 },
    ),
  );

  /**
   * A tier's override replaces one feature's card and leaves the rest of the
   * catalog's prices alone, so an operator can discount one meter without
   * restating every rate.
   */
  it.effect("a tier override replaces only the card it names", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ base: Rate, override: Rate, other: Rate })),
      ({ base, override, other }) => {
        const price = { amount: 1_900, currency: "usd", interval: "month" as const };
        const ai = feature({ id: "ai", name: "AI", rateCard: rateCard({ default: base }) });
        const search = feature({ id: "search", name: "Search", creditRates: { default: other } });
        const free = tier({
          id: "free",
          price,
          grants: [allowance(messages, { included: 10 })],
        });
        const pro = tier({
          id: "pro",
          price,
          credits: 1_000,
          grants: [allowance(messages, { included: 10 })],
          rateCard: { ai: rateCard({ default: override }) },
        });
        const source = Effect.runSync(
          catalog({ features: [ai, search, messages], tiers: [free, pro] }),
        );
        const proRates = ratesOf(source, "pro")!;
        const freeRates = ratesOf(source, "free")!;
        return (
          proRates.ai!.default === override &&
          proRates.search!.default === other &&
          freeRates.ai!.default === base &&
          freeRates.search!.default === other
        );
      },
      { runs: 60 },
    ),
  );
});

/** A card with a rule and a multiplier, so an ask can choose different rates. */
const pricedCard = (fallback: number, large: number, dimension: number, factor: number): RateCard =>
  rateCard({
    default: fallback,
    dimensions: { "gpt-large": dimension },
    rules: [{ match: { size: "large" }, credits: large }],
    multipliers: [{ match: { lifecycle: "spot" }, factor }],
  });

const capture = (() => {
  const price = { amount: 1_900, currency: "usd", interval: "month" as const };
  const card = pricedCard(3, 20, 12, 0.5);
  const ai = feature({ id: "ai", name: "AI", rateCard: card });
  const a = tier({
    id: "a",
    price,
    credits: 100_000,
    grants: [allowance(messages, { included: 10 })],
  });
  const b = tier({
    id: "b",
    price: { amount: 9_900, currency: "usd", interval: "month" },
    credits: 200_000,
    grants: [allowance(messages, { included: 10 })],
    rateCard: { ai: rateCard({ default: 99 }) },
  });
  return { card, source: Effect.runSync(catalog({ features: [ai, messages], tiers: [a, b] })) };
})();

const termsOf = (tierId: string) => {
  const terms = tierTermsOf(capture.source, tierId);
  if (terms === null) throw new Error(`the rate-card catalog is missing ${tierId}`);
  return terms;
};

describe("the rate an event was priced at is the rate it records", () => {
  /**
   * `TrackUsage` prices the event with the card the standing carries, and the
   * event's `cost` is the credits it spent. The hold is the stronger promise: it
   * captures the rate when the work starts, so a tier change mid-flight cannot
   * reprice it, and settle bills what the hold reserved.
   */
  it.effect("a hold captures its rate, and a tier change cannot reprice it", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          billed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
          ask: Ask,
        }),
      ),
      ({ amount, billed, ask }) => {
        const opened = subscribedIn(capture.source, "a");
        const rate = creditRateOf(capture.card, askOf(ask));
        const held = decideAt(
          opened,
          new Hold({
            holdId: "hold-rate",
            feature: "ai",
            amount,
            expiresAt: DateTime.add(start, { days: 30 }),
            ...askOf(ask),
          }),
          start,
          "hold",
        );
        if (!isAccepted(held)) return false;
        const reserved = held.find(
          (event): event is InstanceType<typeof UsageReserved> => event._tag === "UsageReserved",
        );
        if (reserved === undefined || reserved.rate !== rate) return false;
        if (reserved.cost !== amount * rate) return false;

        const withHold = evolveAt(opened, held, start, "hold");
        if (withHold._tag !== "Subscribed") return false;
        const next = termsOf("b");
        const proration =
          prorate({
            from: withHold.price,
            to: next.price,
            period: withHold.period,
            at: start,
          }) ?? undefined;
        const change = decideAt(
          withHold,
          new ChangeTier({
            tier: "b",
            ...next,
            ...(proration === undefined ? {} : { proration }),
          }),
          start,
          "change",
        );
        if (!isAccepted(change)) return false;
        const changed = evolveAt(withHold, change, start, "change");
        if (changed._tag !== "Subscribed") return false;

        const settle = decideAt(
          changed,
          new SettleHold({ holdId: "hold-rate", amount: Math.min(billed, amount) }),
          start,
          "settle",
        );
        if (!isAccepted(settle)) return false;
        const recorded = settle.find(
          (event): event is InstanceType<typeof UsageRecorded> => event._tag === "UsageRecorded",
        );
        const settled = settle.find(
          (event): event is InstanceType<typeof UsageSettled> => event._tag === "UsageSettled",
        );
        if (recorded === undefined || settled === undefined) return false;
        // The hold's rate, not the new tier's card, prices the finished work.
        if (recorded.cost !== Math.min(billed, amount) * rate) return false;
        if (settled.cost !== amount * rate) return false;
        return recorded.creditsAfter === changed.credits - recorded.cost;
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("a tracked event costs the card's rate for its own properties", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          ask: Ask,
        }),
      ),
      ({ amount, ask }) => {
        const opened = subscribedIn(capture.source, "a");
        const rate = creditRateOf(capture.card, askOf(ask));
        const decision = decideAt(
          opened,
          new TrackUsage({ feature: "ai", amount, ...askOf(ask) }),
          start,
          "use",
        );
        if (!isAccepted(decision)) return false;
        const recorded = decision.find(
          (event): event is InstanceType<typeof UsageRecorded> => event._tag === "UsageRecorded",
        );
        return (
          recorded !== undefined &&
          recorded.cost === amount * rate &&
          recorded.creditsAfter === opened.credits - recorded.cost
        );
      },
      { runs: 100, size: 30 },
    ),
  );
});
