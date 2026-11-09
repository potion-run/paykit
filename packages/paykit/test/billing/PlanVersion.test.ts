import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { planRedealOf } from "../../src/Billing/Attach.binding.ts";
import { catalog, planTermsOf, planVersionOf, type Catalog } from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { messages } from "../../src/Feature.ts";
import { ChangeTier, PlanChanged } from "../../src/Subscription/ChangeTier.command.ts";
import { PlanVersionStale } from "../../src/Subscription/PlanVersionStale.rejection.ts";
import {
  PlanChangeScheduled,
  ScheduleTierChange,
} from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import type { SubscribedState } from "../../src/Subscription/Subscription.state.ts";
import { INITIAL_PLAN_VERSION, tier, type Price } from "../../src/Tier.ts";
import { verifyState } from "../../src/Verify.ts";
import { planRow } from "../support/Plans.ts";

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const later = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const account = "acct_version" as const;

/** The same plan at two generations: v1 grants 100, v2 grants 200. */
const v1 = tier({
  id: "pro",
  version: 1,
  grants: [allowance(messages, { included: 100 })],
});

const v2 = tier({
  id: "pro",
  version: 2,
  grants: [allowance(messages, { included: 200 })],
});

const free = tier({ id: "free", grants: [allowance(messages, { included: 10 })] });

const catalogAt = (...tiers: ReadonlyArray<typeof v1>) =>
  Effect.runSync(catalog({ features: [messages], tiers: [...tiers] }));

const v1Catalog = catalogAt(free, v1);
const v2Catalog = catalogAt(free, v2);

const items = (catalog: Catalog, planId: string) => planTermsOf(catalog, planId)?.allowances ?? {};

const subscribed = (version: number, catalogVersion: Catalog = v1Catalog): SubscribedState =>
  ({
    _tag: "Subscribed",
    plans: {
      pro: planRow("pro", {
        version,
        allowances: items(catalogVersion, "pro"),
        credits: 0,
        creditsExpire: "period",
        rates: {},
        interval: "month",
      }),
    },
    schedule: [],
    status: "active",
    period: { start: at, end: later, anchorTz: "UTC" },
    cancelAtPeriodEnd: false,
    credits: 0,
    usage: {},
    remaining: {},
    holds: {},
    refs: {},
    trialUsed: false,
    dedupeKeys: {},
    dunningAttempts: 0,
  }) as unknown as SubscribedState;

const context = Context.make(Actor, system("test"));

describe("a plan states its generation", () => {
  it("defaults to the first generation and round-trips the declared one", () => {
    expect(planTermsOf(v1Catalog, "pro")?.version).toBe(1);
    expect(planTermsOf(v2Catalog, "pro")?.version).toBe(2);
    expect(planVersionOf(v1Catalog, "pro")).toBe(1);
    expect(planVersionOf(v1Catalog, "missing")).toBeNull();
    expect(
      planTermsOf(
        catalogAt(tier({ id: "fresh", grants: [allowance(messages, { included: 1 })] })),
        "fresh",
      )?.version,
    ).toBe(INITIAL_PLAN_VERSION);
  });

  it("a variant inherits its base's generation, and cannot state its own", () => {
    const annual = tier({
      id: "pro_annual",
      variantOf: "pro",
      price: { amount: 1900, currency: "usd", interval: "annual" },
    });

    const resolved = Effect.runSync(catalog({ features: [messages], tiers: [v2, annual] }));

    expect(planVersionOf(resolved, "pro_annual")).toBe(2);
  });
});

describe("the guard", () => {
  it("refuses a command built from an older generation", () => {
    const mismatch = catalogMismatchOf(v2Catalog, { tier: "pro", version: 1 });

    expect(mismatch?._tag).toBe("CatalogMismatch");
    expect(mismatch?.field).toBe("version");
  });

  it("accepts the catalog's own generation", () => {
    expect(catalogMismatchOf(v2Catalog, { tier: "pro", version: 2 })).toBeNull();
  });
});

describe("a generation move is an ordinary plan move", () => {
  it("records the generations and lands the new terms", () => {
    const outcome = Subscription.predict(
      subscribed(1),
      new ChangeTier({
        tier: "pro",
        version: 2,
        allowances: items(v2Catalog, "pro"),
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id: Subscription.ref(account).id, now: at, context },
    );

    expect(outcome._tag).toBe("Accepted");

    if (outcome._tag !== "Accepted") return;
    const changed = outcome.events[0];

    expect(Schema.is(PlanChanged)(changed)).toBe(true);

    if (!Schema.is(PlanChanged)(changed)) return;
    expect(changed.versionBefore ?? 1).toBe(1);
    expect(changed.versionAfter).toBe(2);
    expect(changed.allowances.messages?.included).toBe(200);

    const state = outcome.state;
    expect(state._tag).toBe("Subscribed");

    if (state._tag !== "Subscribed") return;
    expect(state.plans.pro?.version).toBe(2);
  });

  it("refuses to write an older generation over a newer one", () => {
    const outcome = Subscription.predict(
      subscribed(2, v2Catalog),
      new ChangeTier({
        tier: "pro",
        version: 1,
        allowances: items(v1Catalog, "pro"),
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id: Subscription.ref(account).id, now: at, context },
    );

    expect(outcome._tag).toBe("Rejected");

    if (outcome._tag !== "Rejected") return;
    expect(outcome.rejection).toBeInstanceOf(PlanVersionStale);
  });

  it("is scheduled for the boundary like any other move, and the phase freezes the generation", () => {
    const outcome = Subscription.predict(
      subscribed(1),
      new ScheduleTierChange({
        tier: "pro",
        version: 2,
        allowances: items(v2Catalog, "pro"),
        credits: 0,
        creditsExpire: "period",
        rates: {},
        at: later,
      }),
      { id: Subscription.ref(account).id, now: at, context },
    );

    expect(outcome._tag).toBe("Accepted");

    if (outcome._tag !== "Accepted") return;
    const scheduled = outcome.events[0];

    expect(Schema.is(PlanChangeScheduled)(scheduled)).toBe(true);

    if (!Schema.is(PlanChangeScheduled)(scheduled)) return;
    expect(scheduled.version).toBe(2);

    const state = outcome.state;
    expect(state._tag).toBe("Subscribed");

    if (state._tag !== "Subscribed") return;
    expect(state.schedule[0]?.version).toBe(2);
  });

  it("an activation records the generation it bought", () => {
    const outcome = Subscription.predict(
      initialSubscriptionState,
      new Subscribe({
        tier: "pro",
        version: 2,
        allowances: items(v2Catalog, "pro"),
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id: Subscription.ref(account).id, now: at, context },
    );

    expect(outcome._tag).toBe("Accepted");

    if (outcome._tag !== "Accepted") return;
    const activated = outcome.events[0];

    expect(Schema.is(SubscriptionActivated)(activated)).toBe(true);

    if (!Schema.is(SubscriptionActivated)(activated)) return;
    expect(activated.version).toBe(2);

    const state = outcome.state;
    expect(state._tag).toBe("Subscribed");

    if (state._tag !== "Subscribed") return;
    expect(state.plans.pro?.version).toBe(2);
  });
});

describe("attaching a plan again", () => {
  it("is a replay at the same generation", () => {
    expect(planRedealOf(v2Catalog, subscribed(2, v2Catalog).plans.pro, {})).toBe(false);
  });

  it("is a new deal when the catalog moved on", () => {
    expect(planRedealOf(v2Catalog, subscribed(1).plans.pro, {})).toBe(true);
  });

  it("is a new deal when a bespoke set or a negotiated price differs", () => {
    const row = subscribed(2, v2Catalog).plans.pro;
    const bespoke = [allowance(messages, { included: 999 })];
    const price: Price = { amount: 1900, currency: "usd", interval: "month" };

    expect(planRedealOf(v2Catalog, row, { grants: bespoke })).toBe(true);
    expect(planRedealOf(v2Catalog, row, { price })).toBe(true);
    expect(planRedealOf(v2Catalog, undefined, {})).toBe(true);
  });
});

describe("verify reports drift in the generation", () => {
  const catalog: Catalog = v2Catalog;

  it("an older generation is outdated, not a refusal", () => {
    const mismatches = verifyState(account, subscribed(1, catalog), { catalog, provider: null });

    expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["PlanVersionOutdated"]);
  });

  it("a newer generation means the deploy is behind", () => {
    const mismatches = verifyState(account, subscribed(3, catalog), { catalog, provider: null });

    expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["PlanVersionAhead"]);
  });

  it("the same generation with different terms is a missing version bump", () => {
    const state = subscribed(2, catalog);
    const row = state.plans.pro!;

    const tampered: SubscribedState = {
      ...state,
      plans: { pro: { ...row, allowances: items(v1Catalog, "pro") } },
    };

    const mismatches = verifyState(account, tampered, { catalog, provider: null });

    expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["PlanVersionDrift"]);
  });

  it("a matching row is clean", () => {
    expect(verifyState(account, subscribed(2, catalog), { catalog, provider: null })).toEqual([]);
  });
});
