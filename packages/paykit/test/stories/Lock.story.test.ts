import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { ReleaseUsage, UsageReleased } from "../../src/Subscription/ReleaseUsage.command.ts";
import {
  ReservationExceeded,
  ReserveUsage,
  UsageReserved,
} from "../../src/Subscription/ReserveUsage.command.ts";
import {
  NoReservation,
  SettleUsage,
  UsageSettled,
} from "../../src/Subscription/SettleUsage.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "block" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const proAllowances = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = Subscription.ref("acct_lock");
const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const activated = new SubscriptionActivated({
  tier: "pro",
  credits: 0,
  creditsExpire: "period",
  rates: {},
  allowances: proAllowances,
  remaining: { messages: 2000 },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  currency: "usd",
  price: proPrice,
  statusAfter: "active",
});

it.effect("holds allowance, then bills exactly what it held", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: proAllowances,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 400 })),
    Story.then(
      account,
      new UsageReserved({
        feature: "messages",
        amount: 400,
        reservedAfter: 400,
        remainingAfter: 1600,
      }),
    ),
    Story.when(
      account,
      new SettleUsage({ feature: "messages", amount: 400, dedupeKey: "settle-1" }),
    ),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 400,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 400,
        remainingAfter: 1600,
        dedupeKey: "settle-1",
      }),
      new UsageSettled({
        feature: "messages",
        amount: 400,
        reservedAfter: 0,
        remainingAfter: 1600,
      }),
    ),
    // A settle retried with its key is a replay even when the kernel assigns a
    // different command id.
    Story.when(
      account,
      new SettleUsage({ feature: "messages", amount: 100, dedupeKey: "settle-1" }),
    ),
    Story.then(account),
  ),
);

it.effect("refuses a reservation past the spendable amount, and holding twice", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: proAllowances,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 1_800 })),
    Story.then(
      account,
      new UsageReserved({
        feature: "messages",
        amount: 1_800,
        reservedAfter: 1_800,
        remainingAfter: 200,
      }),
    ),
    // Only 200 are spendable now, so a second hold of 300 is refused.
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 300 })),
    Story.rejected(
      new ReservationExceeded({
        feature: "messages",
        included: 2000,
        used: 0,
        reserved: 1_800,
        requested: 300,
        remaining: 200,
      }),
    ),
    // The same reservation retried with a dedupe key holds once.
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 300, dedupeKey: "job-1" })),
    Story.rejected(
      new ReservationExceeded({
        feature: "messages",
        included: 2000,
        used: 0,
        reserved: 1_800,
        requested: 300,
        remaining: 200,
      }),
    ),
  ),
);

it.effect("releases a hold without billing it, and refuses to settle past what is held", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: proAllowances,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 500 })),
    Story.then(
      account,
      new UsageReserved({
        feature: "messages",
        amount: 500,
        reservedAfter: 500,
        remainingAfter: 1500,
      }),
    ),
    Story.when(account, new ReleaseUsage({ feature: "messages", amount: 500 })),
    Story.then(
      account,
      new UsageReleased({
        feature: "messages",
        amount: 500,
        reservedAfter: 0,
        remainingAfter: 2000,
      }),
    ),
    Story.when(account, new SettleUsage({ feature: "messages", amount: 1 })),
    Story.rejected(new NoReservation({ feature: "messages", requested: 1, reserved: 0 })),
  ),
);

it.effect("a settled reservation leaves usage at exactly what was held", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const ref = Subscription.ref("acct_lock_math");
    yield* subscription.send(
      ref,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: proAllowances,
        price: proPrice,
      }),
    );
    yield* subscription.send(ref, new ReserveUsage({ feature: "messages", amount: 700 }));
    yield* subscription.send(ref, new SettleUsage({ feature: "messages", amount: 700 }));
    const state = yield* subscription.state(ref);
    expect(state._tag).toBe("Subscribed");
    if (state._tag !== "Subscribed") return;
    expect(state.usage.messages).toBe(700);
    expect(state.reserved.messages).toBe(0);
    // Reserving did not double-count: 2000 - 700, not 2000 - 1400.
    expect(state.remaining.messages).toBe(1300);
  }).pipe(
    Effect.provide(
      PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
        .pipe(Layer.provide(Domain.InMemory))
        .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test")))),
    ),
  ),
);
