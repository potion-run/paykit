import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { CheckInProcess, CheckReadModel } from "../../src/Check.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingRead } from "../../src/Subscription/BillingRead.projection.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { ReleaseUsage, UsageReleased } from "../../src/Subscription/ReleaseUsage.command.ts";
import { ReserveUsage, UsageReserved } from "../../src/Subscription/ReserveUsage.command.ts";
import { SettleUsage, UsageSettled } from "../../src/Subscription/SettleUsage.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { Track } from "../../src/Track.ts";

const unlimitedTier = tier({
  id: "unlimited",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: "unlimited" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [unlimitedTier] }));
const unlimited = allowancesOf(testCatalog, "unlimited")!;
const price = { amount: 9_900, currency: "usd", interval: "month" as const };
const account = Subscription.ref("acct_unlimited");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const monthAfterThat = at("2030-03-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

/** An account on the unlimited tier: no count, but still a period. */
const activated = new SubscriptionActivated({
  tier: "unlimited",
  allowances: unlimited,
  remaining: { messages: null },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  currency: "usd",
  price,
  statusAfter: "active",
});

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(account, new Subscribe({ tier: "unlimited", allowances: unlimited, price })),
  Story.then(account, activated),
] as const;

const unlimitedFeature = (resetsAt: DateTime.Utc) => ({
  included: "unlimited" as const,
  used: 0,
  reserved: 0,
  allowed: true,
  remaining: null,
  overage: "allow" as const,
  resets: "month" as const,
  resetsAt,
});

it.effect("records usage that never blocks, and keeps no count to report", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1_000_000 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 1_000_000,
        usedAfter: 1_000_000,
        remainingAfter: null,
      }),
    ),
    // A second million still records: there is nothing left to run out of.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1_000_000 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 1_000_000,
        usedAfter: 2_000_000,
        remainingAfter: null,
      }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: { ...unlimitedFeature(monthLater), used: 2_000_000 } },
    }),
  ),
);

it.effect("holds, settles and releases unlimited units without refusing", () =>
  story(
    ...subscribed,
    Story.when(account, new ReserveUsage({ feature: "messages", amount: 5_000_000 })),
    Story.then(
      account,
      new UsageReserved({
        feature: "messages",
        amount: 5_000_000,
        reservedAfter: 5_000_000,
        remainingAfter: null,
      }),
    ),
    Story.when(account, new SettleUsage({ feature: "messages", amount: 4_000_000 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 4_000_000,
        usedAfter: 4_000_000,
        remainingAfter: null,
      }),
      new UsageSettled({
        feature: "messages",
        amount: 4_000_000,
        reservedAfter: 1_000_000,
        remainingAfter: null,
      }),
    ),
    Story.when(account, new ReleaseUsage({ feature: "messages", amount: 1_000_000 })),
    Story.then(
      account,
      new UsageReleased({
        feature: "messages",
        amount: 1_000_000,
        reservedAfter: 0,
        remainingAfter: null,
      }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: { ...unlimitedFeature(monthLater), used: 4_000_000 } },
    }),
  ),
);

it.effect("closes the period: usage resets, the count stays absent, the period still moves", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "messages", amount: 5 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 5,
        usedAfter: 5,
        remainingAfter: null,
      }),
    ),
    // The rollover policy fires `PeriodEnded` when the clock reaches the period
    // end; it runs the same `closePeriodEvents` an explicit `ClosePeriod` does.
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: monthAfterThat,
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({ remaining: { messages: null } }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: monthAfterThat,
      features: { messages: unlimitedFeature(monthAfterThat) },
    }),
  ),
);

const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

it.live("check() answers remaining: null, and the read model keeps it", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const entitlements = yield* Entitlements;
    const receipt = yield* subscription.send(
      Subscription.ref(account.id),
      new Subscribe({ tier: "unlimited", allowances: unlimited, price }),
    );
    yield* entitlements.query(Subscription.ref(account.id), { atLeast: receipt });
    yield* BillingRead.caughtUp(receipt);

    const track = yield* Track();
    const tracked = yield* track({ account: account.id, feature: "messages", amount: 1_000_000 });
    yield* BillingRead.caughtUp(tracked);

    const inProcess = yield* CheckInProcess();
    const answer = yield* inProcess({ account: account.id, feature: "messages" });
    expect(answer.allowed).toBe(true);
    // Unlimited is the absence of a count, not a large one.
    expect(answer.remaining).toBeNull();
    // The period still exists, so it still answers when it ends.
    expect(answer.resetsAt).not.toBeNull();
    expect(answer.standing).toBe("good");

    // The read-model path and the in-process path agree, as they do for a count.
    const readModel = yield* CheckReadModel();
    expect(yield* readModel({ account: account.id, feature: "messages" })).toEqual(answer);

    // The row round-trips the absence of a count, not a zero.
    const store = yield* BillingReadStore;
    const row = yield* store.get(account.id);
    expect(row?.features.messages?.included).toBe("unlimited");
    expect(row?.features.messages?.remaining).toBeNull();
    expect(row?.features.messages?.used).toBe(1_000_000);
  }).pipe(Effect.provide(World)),
);
