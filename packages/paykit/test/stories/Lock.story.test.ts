import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { Hold as holdBinding } from "../../src/Billing/Hold.binding.ts";
import { ReleaseHold as releaseBinding } from "../../src/Billing/ReleaseHold.binding.ts";
import { SettleHold as settleBinding } from "../../src/Billing/SettleHold.binding.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import {
  Hold,
  HoldExceeded,
  HoldSettled,
  HoldUnknown,
  UsageReserved,
} from "../../src/Subscription/Hold.command.ts";
import { ReleaseHold, UsageReleased } from "../../src/Subscription/ReleaseHold.command.ts";
import { SettleHold, UsageSettled } from "../../src/Subscription/SettleHold.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { bindingsWorld } from "../support/Bindings.ts";
import { waitForProjection } from "../support/ReadModel.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const proAllowances = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = Subscription.ref("acct_hold");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const quarter = at("2030-01-01T00:15:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "pro",
      allowances: proAllowances,
      price: proPrice,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "pro",
      allowances: proAllowances,
      remaining: { messages: 2_000 },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price: proPrice,
      statusAfter: "active",
    }),
  ),
] as const;

const held = new UsageReserved({
  holdId: "hold_a",
  feature: "messages",
  amount: 400,
  rate: 0,
  cost: 0,
  at: start,
  expiresAt: quarter,
  remainingAfter: 1_600,
});

it.effect("bills what a hold used and returns the rest in the same command", () =>
  story(
    ...subscribed,
    Story.when(account, new Hold({ holdId: "hold_a", feature: "messages", amount: 400 })),
    Story.then(account, held),
    // 250 of the 400 ran: one call bills them and returns the other 150.
    Story.when(account, new SettleHold({ holdId: "hold_a", amount: 250 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 250,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 250,
        remainingAfter: 1_750,
      }),
      new UsageSettled({
        holdId: "hold_a",
        feature: "messages",
        amount: 250,
        released: 150,
        cost: 0,
        remainingAfter: 1_750,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 2_000,
          used: 250,
          reserved: 0,
          remaining: 1_750,
          carried: 0,
          allowed: true,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
  ),
);

it.effect("settles a whole hold when no amount is given, and a replay bills nothing", () =>
  story(
    ...subscribed,
    Story.when(account, new Hold({ holdId: "hold_a", feature: "messages", amount: 400 })),
    Story.then(account, held),
    Story.when(account, new SettleHold({ holdId: "hold_a" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 400,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 400,
        remainingAfter: 1_600,
      }),
      new UsageSettled({
        holdId: "hold_a",
        feature: "messages",
        amount: 400,
        released: 0,
        cost: 0,
        remainingAfter: 1_600,
      }),
    ),
    // A second settle is the same work billed once: it records nothing.
    Story.when(account, new SettleHold({ holdId: "hold_a" })),
    Story.then(account),
  ),
);

it.effect("refuses what a hold may not do, each with its own tag", () =>
  story(
    ...subscribed,
    // An id nobody issued.
    Story.when(account, new SettleHold({ holdId: "hold_ghost" })),
    Story.rejected(new HoldUnknown({ holdId: "hold_ghost" })),
    // More than there is room for.
    Story.when(account, new Hold({ holdId: "hold_big", feature: "messages", amount: 2_500 })),
    Story.rejected(
      new HoldExceeded({
        feature: "messages",
        requested: 2_500,
        held: 0,
        remaining: 2_000,
      }),
    ),
    Story.when(account, new Hold({ holdId: "hold_a", feature: "messages", amount: 400 })),
    Story.then(account, held),
    // More than the hold holds.
    Story.when(account, new SettleHold({ holdId: "hold_a", amount: 401 })),
    Story.rejected(
      new HoldExceeded({
        holdId: "hold_a",
        feature: "messages",
        requested: 401,
        held: 400,
        remaining: 1_600,
      }),
    ),
    // A released hold was never billed, so a settle refuses it.
    Story.when(account, new ReleaseHold({ holdId: "hold_a" })),
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_a",
        feature: "messages",
        amount: 400,
        cost: 0,
        remainingAfter: 2_000,
      }),
    ),
    Story.when(account, new SettleHold({ holdId: "hold_a" })),
    Story.rejected(new HoldSettled({ holdId: "hold_a", feature: "messages" })),
  ),
);

it.effect("a settled hold cannot be released, and a late release still returns units", () =>
  story(
    ...subscribed,
    Story.when(account, new Hold({ holdId: "hold_a", feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_a",
        feature: "messages",
        amount: 100,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: quarter,
        remainingAfter: 1_900,
      }),
    ),
    Story.when(account, new SettleHold({ holdId: "hold_a" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 100,
        remainingAfter: 1_900,
      }),
      new UsageSettled({
        holdId: "hold_a",
        feature: "messages",
        amount: 100,
        released: 0,
        cost: 0,
        remainingAfter: 1_900,
      }),
    ),
    Story.when(account, new ReleaseHold({ holdId: "hold_a" })),
    Story.rejected(new HoldSettled({ holdId: "hold_a", feature: "messages" })),
    // Past `expiresAt` a hold can still be released: a cleanup, not a charge.
    Story.when(account, new Hold({ holdId: "hold_late", feature: "messages", amount: 50 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_late",
        feature: "messages",
        amount: 50,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: quarter,
        remainingAfter: 1_850,
      }),
    ),
    Story.clock(quarter),
    Story.when(account, new ReleaseHold({ holdId: "hold_late" })),
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_late",
        feature: "messages",
        amount: 50,
        cost: 0,
        remainingAfter: 1_900,
      }),
    ),
  ),
);

it.effect("the sweep releases a hold at its deadline, so a settle is refused", () =>
  story(
    ...subscribed,
    Story.when(account, new Hold({ holdId: "hold_a", feature: "messages", amount: 400 })),
    Story.then(account, held),
    Story.clock(quarter),
    // The policy returns the units at `expiresAt`; nobody sends a release.
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_a",
        feature: "messages",
        amount: 400,
        cost: 0,
        remainingAfter: 2_000,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 2_000,
          used: 0,
          reserved: 0,
          remaining: 2_000,
          carried: 0,
          allowed: true,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
    // The work was never billed, so a late settle has nothing to bill.
    Story.when(account, new SettleHold({ holdId: "hold_a" })),
    Story.rejected(new HoldSettled({ holdId: "hold_a", feature: "messages" })),
    // A late release is the same cleanup, recorded once.
    Story.when(account, new ReleaseHold({ holdId: "hold_a" })),
    Story.then(account),
  ),
);

/** The model, its store and every tenant binding. */
const World = bindingsWorld({
  catalog: testCatalog,
  guards: Layer.succeed(Actor, system("test")),
});

it.live("the bindings hold, settle a partial amount, and release what is left", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const entitlements = yield* Entitlements;
    const receipt = yield* subscription.send(
      Subscription.ref(account.id),
      new Subscribe({
        tier: "pro",
        allowances: proAllowances,
        price: proPrice,
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
    );
    yield* entitlements.query(Subscription.ref(account.id), { atLeast: receipt });

    const hold = yield* holdBinding(account.id);
    const settle = yield* settleBinding(account.id);
    const release = yield* releaseBinding(account.id);

    const placed = yield* hold({ feature: "messages", amount: 400, dedupeKey: "lock-1" });
    expect(placed.holdId).toBeDefined();
    expect(placed.remaining).toBe(1_600);

    // 250 ran: 150 comes back in the same call.
    expect(yield* settle({ holdId: placed.holdId, amount: 250, dedupeKey: "lock-settle" })).toEqual(
      {
        billed: 250,
        released: 150,
      },
    );

    const second = yield* hold({ feature: "messages", amount: 100, dedupeKey: "lock-2" });
    expect(yield* release({ holdId: second.holdId, dedupeKey: "lock-release-2" })).toEqual({
      released: 100,
    });

    // 250 billed, 100 returned: 1,750 is spendable and nothing is held.
    const view = yield* entitlements.query(Subscription.ref(account.id));
    expect(Option.getOrNull(view)).toMatchObject({
      features: { messages: { used: 250, reserved: 0, remaining: 1_750 } },
    });

    // The read model's `reserved` is the fold of the open holds, so it agrees
    // with the view after the same events.
    const store = yield* BillingReadStore;
    const row = yield* waitForProjection(store, account.id, Option.getOrNull(view));
    expect(row?.features.messages?.reserved).toBe(0);
    expect(row?.features.messages?.remaining).toBe(1_750);

    // A hold that has not settled is exactly what `reserved` counts.
    const open = yield* hold({ feature: "messages", amount: 300, dedupeKey: "lock-3" });
    const held = yield* entitlements.query(Subscription.ref(account.id));
    const heldRow = yield* waitForProjection(store, account.id, Option.getOrNull(held));
    expect(heldRow?.features.messages?.reserved).toBe(300);
    expect(heldRow?.features.messages?.remaining).toBe(1_450);
    yield* release({ holdId: open.holdId, dedupeKey: "lock-release-3" });
  }).pipe(Effect.provide(World)),
);

/**
 * A credit-priced feature holds credits, not units, so a release has to return
 * `amount × rate`. The view recomputes a credit feature's remaining from the
 * pool, which is why this bug is invisible to `check()` and only shows up in the
 * event the log keeps.
 */
const creditRates = { ai: { default: 1, "gpt-large": 10 } };
const creditSubscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "pro",
      allowances: proAllowances,
      price: proPrice,
      credits: 50_000,
      creditsExpire: "period",
      rates: creditRates,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "pro",
      allowances: proAllowances,
      remaining: { messages: 2_000 },
      credits: 50_000,
      creditsExpire: "period",
      rates: creditRates,
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price: proPrice,
      statusAfter: "active",
    }),
  ),
] as const;

it.effect("returns what a credit hold did not spend, in credits", () =>
  story(
    ...creditSubscribed,
    Story.when(
      account,
      new Hold({ holdId: "hold_ai", feature: "ai", amount: 100, dimension: "gpt-large" }),
    ),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_ai",
        feature: "ai",
        amount: 100,
        dimension: "gpt-large",
        rate: 10,
        cost: 1_000,
        at: start,
        expiresAt: quarter,
        remainingAfter: 49_000,
      }),
    ),
    Story.when(account, new ReleaseHold({ holdId: "hold_ai" })),
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_ai",
        feature: "ai",
        amount: 100,
        // 100 units at 10 credits is 1,000 credits back, not 100.
        cost: 1_000,
        remainingAfter: 50_000,
      }),
    ),
  ),
);
