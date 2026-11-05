import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { actionsFor, type AdminAction } from "../../src/AdminActions.ts";
import { allowance } from "../../src/Allowance.ts";
import { Actor, admin } from "../../src/Auth/Actor.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import {
  BillingState,
  initialBillingState,
  type BillingStateView,
} from "../../src/Subscription/BillingState.view.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { planChangeTier } from "../../src/Subscription/ChangeTier.plan.ts";
import { EnterGrace } from "../../src/Subscription/EnterGrace.command.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "../../src/Subscription/Entitlements.view.ts";
import { Expire } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial } from "../../src/Subscription/ExtendTrial.command.ts";
import { GrantCredits } from "../../src/Subscription/GrantCredits.command.ts";
import { RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover } from "../../src/Subscription/Recover.command.ts";
import { Resume } from "../../src/Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  propertyAccount,
  Script,
  testCatalog as generatedCatalog,
  walk,
} from "../properties/Arbitraries.ts";
import { assertProperty } from "../support/Property.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const scale = tier({
  id: "scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5_000 })],
});
const euro = tier({
  id: "euro",
  price: { amount: 1_900, currency: "eur", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [free, pro, scale, euro] }),
);

const state = (
  status: "trialing" | "active" | "grace" | "canceled" | "expired",
  overrides: { readonly cancelAtPeriodEnd?: boolean; readonly tier?: string } = {},
) => ({
  status,
  tier: overrides.tier ?? "pro",
  currency: "usd" as string | undefined,
  cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
});

const actions = (
  status: "trialing" | "active" | "grace" | "canceled" | "expired",
  overrides: { readonly cancelAtPeriodEnd?: boolean; readonly tier?: string } = {},
  options: Parameters<typeof actionsFor>[1] = { catalog: testCatalog },
) => actionsFor(state(status, overrides), options).map((descriptor) => descriptor.action);

const entitlements = (used: number, reserved = 0): EntitlementsState =>
  ({
    account: "acct_1",
    tier: "pro",
    status: "active",
    standing: "good",
    periodStart: 0,
    periodEnd: 0,
    cancelAtPeriodEnd: false,
    credits: 0,
    dunningAttempts: 0,
    features: {
      messages: {
        included: 2_000,
        used,
        reserved,
        remaining: 2_000 - used - reserved,
        allowed: true,
        overage: "block",
        resets: "month",
        resetsAt: null,
      },
    },
  }) as unknown as EntitlementsState;

describe("admin actions", () => {
  it("offers the trial actions only while trialing", () => {
    expect(actions("trialing")).toContain("ExtendTrial");
    expect(actions("active")).not.toContain("ExtendTrial");
    expect(actions("grace")).not.toContain("ExtendTrial");
  });

  it("offers recovery, expiry and a payment only in grace", () => {
    expect(actions("grace")).toEqual(
      expect.arrayContaining(["RecordPayment", "Recover", "Expire"]),
    );
    expect(actions("active")).not.toContain("Recover");
    expect(actions("active")).not.toContain("Expire");
  });

  it("swaps cancellation and resume on the flag, never both", () => {
    const scheduled = actions("active", { cancelAtPeriodEnd: true });
    expect(scheduled).toContain("Resume");
    expect(scheduled).not.toContain("ScheduleCancellation");

    const running = actions("active");
    expect(running).toContain("ScheduleCancellation");
    expect(running).not.toContain("Resume");
  });

  it("offers no action once a standing is over", () => {
    expect(actions("canceled")).toEqual([]);
    expect(actions("expired")).toEqual([]);
  });

  it("offers ChangeTier only with another compatible tier", () => {
    const descriptor = actionsFor(state("active"), { catalog: testCatalog }).find(
      (candidate) => candidate.action === "ChangeTier",
    );
    expect(descriptor?.tiers).toEqual(["free", "scale"]);
  });

  it("does not offer ChangeTier when the account usage exceeds every other tier", () => {
    const descriptor = actionsFor(state("active"), {
      catalog: testCatalog,
      entitlements: entitlements(4_500),
    }).find((candidate) => candidate.action === "ChangeTier");
    // `free` grants 100 and `scale` grants 5,000; 4,500 fits scale but not free.
    expect(descriptor?.tiers).toEqual(["scale"]);
  });

  it("does not offer a tier that open holds would oversubscribe", () => {
    // A counterexample the property test found: `free` includes 100 and the
    // account has used none, but 4,500 units are held. `ChangeTier` counts a
    // hold as owed, so the console must not offer the move.
    const descriptor = actionsFor(state("active"), {
      catalog: testCatalog,
      entitlements: entitlements(0, 4_500),
    }).find((candidate) => candidate.action === "ChangeTier");
    expect(descriptor?.tiers).toEqual(["scale"]);
  });

  it("does not offer ChangeTier when there is no other tier", () => {
    const only = Effect.runSync(catalog({ features: [messages], tiers: [pro] }));
    expect(actions("active", { tier: "pro" }, { catalog: only })).not.toContain("ChangeTier");
  });
});

type Event = Readonly<{ readonly _tag: string }>;

const billingHandlers = BillingState.definition.evolve as unknown as Record<
  string,
  (state: BillingStateView, event: Event, context: unknown) => BillingStateView
>;

const entitlementHandlers = Entitlements.definition.evolve as unknown as Record<
  string,
  (state: EntitlementsState, event: Event, context: unknown) => EntitlementsState
>;

/** Fold the events a generated script committed into the billing page. */
const foldBilling = (events: ReadonlyArray<Event>): BillingStateView =>
  events.reduce<BillingStateView>((view, event) => {
    const handler = billingHandlers[event._tag];
    return handler === undefined ? view : handler(view, event, { key: { id: propertyAccount } });
  }, initialBillingState);

/** Fold the same events into the allowance page the console shows beside it. */
const foldEntitlements = (events: ReadonlyArray<Event>): EntitlementsState =>
  events.reduce<EntitlementsState>((view, event) => {
    const handler = entitlementHandlers[event._tag];
    return handler === undefined ? view : handler(view, event, { key: { id: propertyAccount } });
  }, initialEntitlements);

type ConsoleCommand =
  | ChangeTier
  | EnterGrace
  | Expire
  | ExtendTrial
  | GrantCredits
  | RecordPayment
  | RecordPaymentFailure
  | Recover
  | Resume
  | ScheduleCancellation;

/**
 * The command the console's intent would build for one offered action: the
 * same command classes `update` sends, with the values an operator could
 * enter, and a tier change planned from the catalog exactly as the quote is.
 */
const commandFor = (
  action: AdminAction,
  tierId: string | null,
  state: SubscriptionState,
  now: DateTime.Utc,
): ConsoleCommand | null => {
  const soon = DateTime.add(now, { days: 7 });
  switch (action) {
    case "GrantCredits":
      return new GrantCredits({ amount: 250 });
    case "ExtendTrial":
      return new ExtendTrial({ trialEndsAt: soon });
    case "EnterGrace":
      return new EnterGrace({ graceUntil: soon });
    case "RecordPayment":
      return new RecordPayment({ amount: 100, currency: "usd" });
    case "RecordPaymentFailure":
      return new RecordPaymentFailure({ reason: "card_declined", graceUntil: soon });
    case "Recover":
      return new Recover();
    case "Expire":
      return new Expire();
    case "ScheduleCancellation":
      return new ScheduleCancellation();
    case "Resume":
      return new Resume();
    case "ChangeTier":
      return tierId === null
        ? null
        : (planChangeTier(generatedCatalog, tierId, state, now)?.command ?? null);
  }
};

describe("offered actions", () => {
  it.effect("offers only actions the model would accept", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        const { state, events, now } = walk(script);
        const billing = foldBilling(events);
        const entitlements = foldEntitlements(events);
        const context = Context.make(Actor, admin("ops_property"));
        const id = Subscription.ref(propertyAccount).id;
        const offered = actionsFor(billing, { catalog: generatedCatalog, entitlements });

        for (const descriptor of offered) {
          const tiers: ReadonlyArray<string | null> =
            descriptor.action === "ChangeTier" ? descriptor.tiers : [null];
          // `actionsFor` must not offer a change with no tier to change to.
          if (tiers.length === 0) return false;
          for (const tierId of tiers) {
            const command = commandFor(descriptor.action, tierId, state, now);
            if (command === null) return false;
            const prediction = Subscription.predict(state, command, {
              id,
              now,
              context,
            });
            // An action the console offers is an action the model must not
            // refuse: the operator would be looking at a button that can only
            // return a rejection.
            if (prediction._tag === "Rejected") return false;
          }
        }
        return true;
      },
      { runs: 300, size: 40 },
    ),
  );
});
