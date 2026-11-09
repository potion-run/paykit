import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import { planItemsOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { AccountEvents } from "../../src/Subscription/AccountEvents.stream.ts";
import { BillingRead } from "../../src/Subscription/BillingRead.projection.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { waitForProjection } from "../support/ReadModel.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = planItemsOf(testCatalog, "free")!;
const account = Subscription.ref("acct_read");
const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const end = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

it.effect("appends every subscription event to AccountEvents", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "free",
        allowances: free,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "free",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: free,
        remaining: { messages: 100 },
        periodStart: start,
        periodEnd: end,
        anchorTz: "UTC",
        interval: "month",
        statusAfter: "active",
      }),
    ),
    Story.streamed(
      AccountEvents,
      account,
      new SubscriptionActivated({
        tier: "free",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: free,
        remaining: { messages: 100 },
        periodStart: start,
        periodEnd: end,
        anchorTz: "UTC",
        interval: "month",
        statusAfter: "active",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 12 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 12,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 12,
        remainingAfter: 88,
      }),
    ),
    Story.streamed(
      AccountEvents,
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 12,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 12,
        remainingAfter: 88,
      }),
    ),
  ),
);

it.live("BillingRead serves a cross-account row after the projection catches up", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const store = yield* BillingReadStore;
    const state = yield* Entitlements;
    const ref = Subscription.ref("acct_read_live");

    const receipt = yield* subscription.send(
      ref,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "free",
        allowances: free,
      }),
    );

    // BillingRead consumes Entitlements, so wait for the view before the projection.
    const view = Option.getOrNull(yield* state.query(ref, { atLeast: receipt }));
    yield* BillingRead.caughtUp(receipt);
    // The row can still trail the progress report under a loaded suite, so wait
    // for it to say what the view says rather than assuming one delivery feeds
    // both consumers.
    yield* waitForProjection(store, "acct_read_live", view);
    const page = yield* store.list();
    expect(page.rows.length).toBe(1);
    expect(page.next).toBeNull();
    expect(page.rows[0]?.account).toBe("acct_read_live");
    expect(page.rows[0]?.tier).toBe("free");
    expect(page.rows[0]?.standing).toBe("good");
    expect(page.rows[0]?.credits).toBe(0);
    expect(page.rows[0]?.features.messages?.included).toBe(100);
  }).pipe(
    Effect.provide(
      PaykitModel.layer(PaykitHandlers)
        .pipe(Layer.provideMerge(MemoryBillingReadStore))
        .pipe(Layer.provide(Domain.InMemory))
        .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test")))),
    ),
  ),
);
