import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import {
  CatalogCapWithoutBilling,
  allowancesOf,
  catalog,
  defineCatalog,
} from "../../src/Catalog.ts";
import { CheckInProcess, CheckReadModel } from "../../src/Check.ts";
import { messages } from "../../src/Feature.ts";
import { Hold as HoldBinding, Release } from "../../src/Hold.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Hold, UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  SpendCapExceeded,
  TrackUsage,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { Track } from "../../src/Track.ts";
import { waitForProjection } from "../support/ReadModel.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

// 100 included, 20 more billable, then the ceiling: 120 units a period.
const cappedTier = tier({
  id: "capped",
  price,
  grants: [allowance(messages, { included: 100, overage: "bill", cap: 20 })],
});
// The same allowance without a ceiling, to prove the old behaviour is intact.
const openTier = tier({
  id: "open",
  price,
  grants: [allowance(messages, { included: 100, overage: "bill" })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [cappedTier, openTier] }),
);
const account = Subscription.ref("acct_cap");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const subscribed = (tierId: string) => {
  const allowances = allowancesOf(testCatalog, tierId)!;
  return [
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        tier: tierId,
        allowances,
        price,
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: tierId,
        allowances,
        remaining: { messages: 100 },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        price,
        statusAfter: "active",
      }),
    ),
  ] as const;
};

const feature = (over: {
  remaining: number;
  used?: number;
  reserved?: number;
  allowed?: boolean;
}) => ({
  included: 100,
  used: over.used ?? 0,
  reserved: over.reserved ?? 0,
  remaining: over.remaining,
  carried: 0,
  allowed: over.allowed ?? true,
  overage: "bill" as const,
  cap: 20,
  resets: "month" as const,
  resetsAt: monthLater,
});

it("refuses a cap where nothing is billed", () => {
  const cases = [
    allowance(messages, { included: 100, overage: "block", cap: 20 }),
    allowance(messages, { included: 100, overage: "allow", cap: 20 }),
    // `unlimited` defaults to "allow", so a cap beside it is the same mistake.
    allowance(messages, { included: "unlimited", cap: 20 }),
  ];
  for (const grant of cases) {
    const result = defineCatalog({
      features: [messages],
      tiers: [tier({ id: "capped", grants: [grant] })],
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(CatalogCapWithoutBilling)(result.failure)).toBe(true);
      if (!Schema.is(CatalogCapWithoutBilling)(result.failure)) return;
      expect(result.failure.tier).toBe("capped");
      expect(result.failure.feature).toBe("messages");
    }
  }
});

it.effect("bills up to the ceiling and refuses the unit past it", () =>
  story(
    ...subscribed("capped"),
    // One unit below the ceiling.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 119 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 119,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 119,
        remainingAfter: -19,
      }),
    ),
    // The unit that reaches it is still billed.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 1,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 120,
        remainingAfter: -20,
      }),
    ),
    // One more would pass `included + cap`.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1 })),
    Story.rejected(
      new SpendCapExceeded({ feature: "messages", cap: 20, used: 120, reserved: 0, requested: 1 }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: feature({ remaining: -20, used: 120, allowed: false }) },
    }),
  ),
);

it.effect("counts a hold against the ceiling", () =>
  story(
    ...subscribed("capped"),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 100,
        remainingAfter: 0,
      }),
    ),
    // 20 units of headroom: the hold takes them all.
    Story.when(account, new Hold({ holdId: "hold_cap", feature: "messages", amount: 20 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_cap",
        feature: "messages",
        amount: 20,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: at("2030-01-01T00:15:00Z"),
        remainingAfter: -20,
      }),
    ),
    // A hold is a promise to bill, so the tracked unit beside it is refused.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1 })),
    Story.rejected(
      new SpendCapExceeded({ feature: "messages", cap: 20, used: 100, reserved: 20, requested: 1 }),
    ),
    // And so is a hold past the ceiling.
    Story.when(account, new Hold({ holdId: "hold_over", feature: "messages", amount: 1 })),
    Story.rejected(
      new SpendCapExceeded({ feature: "messages", cap: 20, used: 100, reserved: 20, requested: 1 }),
    ),
  ),
);

it.effect("a period close frees the headroom again", () =>
  story(
    ...subscribed("capped"),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 120 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 120,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 120,
        remainingAfter: -20,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: at("2030-03-01T00:00:00Z"),
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    // `used` reset, so the ceiling is 120 units away again.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 120 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 120,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 120,
        remainingAfter: -20,
      }),
    ),
  ),
);

it.effect("an uncapped billed allowance is unchanged", () =>
  story(
    ...subscribed("open"),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 500,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 500,
        remainingAfter: -400,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 100,
          used: 500,
          reserved: 0,
          remaining: -400,
          carried: 0,
          allowed: true,
          overage: "bill",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
  ),
);

const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

it.live("check() refuses at the ceiling while the standing stays good, on every path", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const entitlements = yield* Entitlements;
    const store = yield* BillingReadStore;
    const ref = Subscription.ref(account.id);
    const receipt = yield* subscription.send(
      ref,
      new Subscribe({
        tier: "capped",
        allowances: allowancesOf(testCatalog, "capped")!,
        price,
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
    );
    yield* entitlements.query(ref, { atLeast: receipt });

    const check = yield* CheckInProcess();
    const withinCeiling = yield* check({ account: account.id, feature: "messages", amount: 120 });
    expect(withinCeiling.allowed).toBe(true);
    expect(withinCeiling.remaining).toBe(100);
    expect(withinCeiling.standing).toBe("good");
    expect(withinCeiling.resetsAt).not.toBeNull();
    // 121 units would pass `included + cap`.
    expect((yield* check({ account: account.id, feature: "messages", amount: 121 })).allowed).toBe(
      false,
    );

    const track = yield* Track();
    yield* track({ account: account.id, feature: "messages", amount: 120 });

    const atCeiling = yield* check({ account: account.id, feature: "messages", amount: 1 });
    expect(atCeiling.allowed).toBe(false);
    // Out of what it bought, not in trouble: the standing is still good.
    expect(atCeiling.standing).toBe("good");
    expect(atCeiling.remaining).toBe(-20);

    // The three read paths agree, from the row alone.
    yield* waitForProjection(store, account.id, Option.getOrNull(yield* entitlements.query(ref)));
    const readModel = yield* CheckReadModel();
    expect(yield* readModel({ account: account.id, feature: "messages", amount: 1 })).toEqual(
      atCeiling,
    );

    const row = yield* waitForProjection(
      store,
      account.id,
      Option.getOrNull(yield* entitlements.query(ref)),
    );
    expect(row?.features.messages?.cap).toBe(20);
    expect(row?.features.messages?.used).toBe(120);

    // A hold that would pass the ceiling is refused, and does not change it.
    const refused = yield* Effect.exit(
      (yield* HoldBinding())({ account: account.id, feature: "messages", amount: 1 }),
    );
    expect(refused._tag).toBe("Failure");
    expect(String(refused)).toContain("SpendCapExceeded");

    // A released hold that fit would have returned its units; this one left is
    // still 20 short, and releasing nothing issued changes nothing.
    const release = yield* Release();
    const unknown = yield* Effect.exit(release({ account: account.id, holdId: "hold_none" }));
    expect(unknown._tag).toBe("Failure");
  }).pipe(Effect.provide(World)),
);
