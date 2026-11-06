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
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { WithdrawTierChange } from "../../src/Subscription/WithdrawTierChange.command.ts";
import { tier } from "../../src/Tier.ts";
import { planChangeTier, scheduleTierChangeInputOf } from "../../src/TierCommand.ts";
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

/**
 * Two tiers with the two ceilings `ChangeTier` refuses to move under. One is a
 * unit ceiling (`included + cap`), the other a money ceiling the period may not
 * bill past.
 */
const capped = tier({
  id: "capped",
  price: { amount: 900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 100, overage: "bill", cap: 20 })],
});
const metered = tier({
  id: "metered",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      unitPrice: { amount: 5, currency: "usd" },
      moneyCap: 500,
    }),
  ],
});
const ceilings = Effect.runSync(catalog({ features: [messages], tiers: [capped, metered] }));

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

/** The same row for the money tiers: a bill allowance carrying both ceilings. */
const ceilingEntitlements = (feature: {
  readonly used: number;
  readonly billed: number;
}): EntitlementsState =>
  ({
    account: "acct_1",
    tier: "metered",
    status: "active",
    standing: "good",
    periodStart: 0,
    periodEnd: 0,
    cancelAtPeriodEnd: false,
    credits: 0,
    dunningAttempts: 0,
    features: {
      messages: {
        included: 100,
        used: feature.used,
        reserved: 0,
        remaining: 100 - feature.used,
        allowed: true,
        overage: "bill",
        resets: "month",
        resetsAt: null,
        cap: 20,
        unitPrice: { amount: 5, currency: "usd" },
        moneyCap: 500,
        ...(feature.billed === 0 ? {} : { billed: feature.billed }),
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

  it("offers a tier that sells in the standing's additional currency", () => {
    const bilingual = tier({
      id: "bilingual",
      price: {
        amount: 1_900,
        currency: "usd",
        interval: "month",
        additionalCurrencies: [{ currency: "eur", amount: 1_800 }],
      },
      grants: [allowance(messages, { included: 2_000 })],
    });
    const multi = Effect.runSync(catalog({ features: [messages], tiers: [pro, bilingual] }));
    const offered = actionsFor({ ...state("active"), currency: "eur" }, { catalog: multi });

    expect(offered.find((descriptor) => descriptor.action === "ChangeTier")?.tiers).toContain(
      "bilingual",
    );
    expect(
      offered.find((descriptor) => descriptor.action === "ScheduleTierChange")?.tiers,
    ).toContain("bilingual");
  });

  it("does not offer ChangeTier when there is no other tier", () => {
    const only = Effect.runSync(catalog({ features: [messages], tiers: [pro] }));
    expect(actions("active", { tier: "pro" }, { catalog: only })).not.toContain("ChangeTier");
  });

  it("does not offer a tier whose unit ceiling the period already passed", () => {
    // `capped` bills up to `included + cap` = 120 units and the account has used
    // 190 of them. `ChangeTier` refuses the move (`DowngradeBelowCeiling`), so
    // the console must not put it on screen: every later `TrackUsage` would be
    // refused until the period resets.
    const offered = actionsFor(state("active", { tier: "metered" }), {
      catalog: ceilings,
      entitlements: ceilingEntitlements({ used: 190, billed: 450 }),
    });
    expect(offered.map((descriptor) => descriptor.action)).not.toContain("ChangeTier");
  });

  it("does not offer a tier whose money ceiling the period already billed past", () => {
    // `metered` may bill 500 minor units a period. The counters are well under
    // `capped`'s unit ceiling in both cases, so only the money rule can keep
    // the move off the screen.
    const offered = (billed: number) =>
      actionsFor(state("active", { tier: "capped" }), {
        catalog: ceilings,
        entitlements: ceilingEntitlements({ used: 50, billed }),
      });

    expect(offered(400).find((descriptor) => descriptor.action === "ChangeTier")?.tiers).toEqual([
      "metered",
    ]);
    expect(offered(600).map((descriptor) => descriptor.action)).not.toContain("ChangeTier");
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
  | ScheduleCancellation
  | ScheduleTierChange
  | WithdrawTierChange;

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
  // An extension has to land past the deadline already in force, which is not
  // the same as past `now`: a trial extended twice must move forward twice.
  const extended =
    state._tag === "Subscribed" && state.trialEndsAt !== undefined
      ? DateTime.add(
          DateTime.toEpochMillis(state.trialEndsAt) > DateTime.toEpochMillis(now)
            ? state.trialEndsAt
            : now,
          { days: 7 },
        )
      : soon;
  switch (action) {
    case "GrantCredits":
      return new GrantCredits({ amount: 250 });
    case "ExtendTrial":
      return new ExtendTrial({ trialEndsAt: extended });
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
    case "WithdrawTierChange":
      return new WithdrawTierChange();
    case "ChangeTier": {
      if (tierId === null) return null;
      const plan = planChangeTier(generatedCatalog, tierId, state, now);
      return plan === null ? null : new ChangeTier(plan.input);
    }
    case "ScheduleTierChange": {
      if (tierId === null) return null;
      const input = scheduleTierChangeInputOf(generatedCatalog, tierId);
      return input === null ? null : new ScheduleTierChange(input);
    }
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
            descriptor.action === "ChangeTier" || descriptor.action === "ScheduleTierChange"
              ? descriptor.tiers
              : [null];
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

describe("a change at the period end", () => {
  /** A standing on `pro` with no entitlements supplied, plus a pending tier. */
  const pending = (tier: string) => ({
    tier,
    allowances: {},
    credits: 0,
    creditsExpire: "period" as const,
    rates: {},
  });

  it("offers scheduling where ChangeTier is refused, and withdraw while it is pending", () => {
    // `free` includes 100 and the account has used 4,500, so a mid-period move is
    // `DowngradeBelowUsage` — the boundary is the only place that request fits.
    const offered = actionsFor(state("active"), {
      catalog: testCatalog,
      entitlements: entitlements(4_500),
    });
    const change = offered.find((descriptor) => descriptor.action === "ChangeTier");
    const schedule = offered.find((descriptor) => descriptor.action === "ScheduleTierChange");
    expect(change?.tiers).toEqual(["scale"]);
    // `euro` is a different currency; the rest are offered even though the move
    // is refused now.
    expect(schedule?.tiers).toEqual(["free", "scale"]);
    // Nothing is scheduled yet, so there is nothing to withdraw.
    expect(offered.map((descriptor) => descriptor.action)).not.toContain("WithdrawTierChange");
  });

  it("never offers a one-off pack as a tier", () => {
    // A pack has no allowances, so both the mid-period change and the boundary
    // change would be refused. The console must not render a button that can
    // only return `TierNotInCatalog`.
    const pack = tier({
      id: "pack",
      kind: "one_off",
      price: { amount: 4_900, currency: "usd", interval: "month" },
      credits: 10_000,
      grants: [] as never,
    });
    const withPack = Effect.runSync(catalog({ features: [messages], tiers: [free, pro, pack] }));
    const offered = actionsFor(state("active"), { catalog: withPack });
    for (const action of ["ChangeTier", "ScheduleTierChange"] as const) {
      expect(offered.find((descriptor) => descriptor.action === action)?.tiers).not.toContain(
        "pack",
      );
    }
  });

  it("offers the withdrawal only while a change is scheduled", () => {
    const pendingTier = pending("free");
    const offered = actionsFor({ ...state("active"), pendingTier } as never, {
      catalog: testCatalog,
    });
    expect(offered.map((descriptor) => descriptor.action)).toContain("WithdrawTierChange");

    const withdrawn = actionsFor(state("active"), { catalog: testCatalog });
    expect(withdrawn.map((descriptor) => descriptor.action)).not.toContain("WithdrawTierChange");
  });
});
