import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, creditTermsOf } from "../../src/Catalog.ts";
import { CheckInProcess, CheckReadModel } from "../../src/Check.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { ChangeTier, TierChanged } from "../../src/Subscription/ChangeTier.command.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { ReleaseUsage } from "../../src/Subscription/ReleaseUsage.command.ts";
import {
  CreditHoldUnsupported,
  ReserveUsage,
} from "../../src/Subscription/ReserveUsage.command.ts";
import { SettleUsage } from "../../src/Subscription/SettleUsage.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  TrackUsage,
  CreditExceeded,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { Track } from "../../src/Track.ts";
import { waitForProjection } from "../support/ReadModel.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });
const price = { amount: 9_900, currency: "usd", interval: "month" as const };

const creditsTier = tier({
  id: "credits",
  price,
  credits: 50_000,
  grants: [allowance(messages, { included: 100 })],
});
const keepTier = tier({
  id: "keep",
  price,
  credits: 50_000,
  creditsExpire: "never",
  grants: [allowance(messages, { included: 100 })],
});
const noCreditsTier = tier({
  id: "smaller",
  price,
  grants: [allowance(messages, { included: 100 })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [ai, messages], tiers: [creditsTier, keepTier, noCreditsTier] }),
);
const terms = (id: string) => creditTermsOf(testCatalog, id)!;
const creditsTerms = terms("credits");
const keepTerms = terms("keep");
const account = Subscription.ref("acct_credits");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const monthAfterThat = at("2030-03-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const creditFeature = (over: {
  readonly remaining: number;
  readonly used?: number;
  readonly allowed?: boolean;
}) => ({
  creditRates: { default: 1, "gpt-large": 10 },
  included: null,
  used: over.used ?? 0,
  reserved: 0,
  remaining: over.remaining,
  carried: 0,
  allowed: over.allowed ?? true,
  overage: "block" as const,
  resets: "never" as const,
  resetsAt: null,
});

const subscribed = (tierId: string, grant: typeof creditsTerms) =>
  [
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        tier: tierId,
        allowances: allowancesOf(testCatalog, tierId)!,
        price,
        credits: grant.credits,
        creditsExpire: grant.creditsExpire,
        rates: grant.rates,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: tierId,
        allowances: allowancesOf(testCatalog, tierId)!,
        remaining: { messages: 100 },
        credits: grant.credits,
        creditsExpire: grant.creditsExpire,
        rates: grant.rates,
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

it.effect("spends the pool at rate × amount, by dimension", () =>
  story(
    ...subscribed("credits", creditsTerms),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 100, dimension: "gpt-large" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 100,
        cost: 1_000,
        creditsAfter: 49_000,
        usedAfter: 1_000,
        remainingAfter: 49_000,
      }),
    ),
    // No dimension prices at the card's default.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 5 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 5,
        cost: 5,
        creditsAfter: 48_995,
        usedAfter: 1_005,
        remainingAfter: 48_995,
      }),
    ),
    Story.view(Entitlements, account, {
      credits: 48_995,
      features: {
        ai: creditFeature({ remaining: 48_995, used: 1_005 }),
        messages: {
          included: 100,
          used: 0,
          reserved: 0,
          remaining: 100,
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

it.effect("refuses an overspend and leaves the pool untouched", () =>
  story(
    ...subscribed("credits", creditsTerms),
    // 6,000 units at 10 credits is 60,000: more than the pool holds.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 6_000, dimension: "gpt-large" })),
    Story.rejected(new CreditExceeded({ feature: "ai", cost: 60_000, balance: 50_000 })),
    // Nothing was recorded, so the pool is still whole.
    Story.view(Entitlements, account, {
      credits: 50_000,
      features: { ai: creditFeature({ remaining: 50_000 }) },
    }),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 5_000, dimension: "gpt-large" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 5_000,
        cost: 50_000,
        creditsAfter: 0,
        usedAfter: 50_000,
        remainingAfter: 0,
      }),
    ),
    // The pool is empty, so one more credit is refused.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1 })),
    Story.rejected(new CreditExceeded({ feature: "ai", cost: 1, balance: 0 })),
  ),
);

it.effect("refuses a hold on a credit-priced feature", () =>
  story(
    ...subscribed("credits", creditsTerms),
    Story.when(account, new ReserveUsage({ feature: "ai", amount: 1 })),
    Story.rejected(new CreditHoldUnsupported({ feature: "ai" })),
    Story.when(account, new SettleUsage({ feature: "ai", amount: 1 })),
    Story.rejected(new CreditHoldUnsupported({ feature: "ai" })),
    Story.when(account, new ReleaseUsage({ feature: "ai", amount: 1 })),
    Story.rejected(new CreditHoldUnsupported({ feature: "ai" })),
  ),
);

it.effect("expires a period pool at the close, and keeps a pool that never expires", () =>
  story(
    ...subscribed("credits", creditsTerms),
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
      new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
      new CreditsExpired({ amount: 50_000, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, {
      credits: 0,
      features: { ai: creditFeature({ remaining: 0, allowed: false }) },
    }),
  ),
);

it.effect("keeps a pool whose grant never expires", () =>
  story(
    ...subscribed("keep", keepTerms),
    Story.clock(monthLater),
    Story.then(
      account,
      // No `CreditsExpired`: expiry is a property of the grant.
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: monthAfterThat,
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
    ),
    Story.view(Entitlements, account, {
      credits: 50_000,
      features: { ai: creditFeature({ remaining: 50_000 }) },
    }),
  ),
);

it.effect("a tier change carries the balance over instead of re-granting", () =>
  story(
    ...subscribed("credits", creditsTerms),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1_000, dimension: "gpt-large" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 1_000,
        cost: 10_000,
        creditsAfter: 40_000,
        usedAfter: 10_000,
        remainingAfter: 40_000,
      }),
    ),
    Story.when(
      account,
      new ChangeTier({
        tier: "smaller",
        allowances: allowancesOf(testCatalog, "smaller")!,
        price,
        credits: 0,
        creditsExpire: "period",
        rates: creditsTerms.rates,
        // Same price on both sides, so the change owes nothing.
        proration: { currency: "usd", credit: 9_900, charge: 9_900, due: 0 },
      }),
    ),
    Story.then(
      account,
      new TierChanged({
        tier: "smaller",
        allowances: allowancesOf(testCatalog, "smaller")!,
        remaining: { messages: 100 },
        credits: 40_000,
        creditsExpire: "period",
        rates: creditsTerms.rates,
        currency: "usd",
        interval: "month",
        priceBefore: price,
        priceAfter: price,
        proration: { currency: "usd", credit: 9_900, charge: 9_900, due: 0 },
      }),
    ),
    Story.view(Entitlements, account, { credits: 40_000 }),
  ),
);

const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

it.live("check prices a request from the pool, by dimension, on every read path", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const entitlements = yield* Entitlements;
    const store = yield* BillingReadStore;
    const ref = Subscription.ref(account.id);
    const receipt = yield* subscription.send(
      ref,
      new Subscribe({
        tier: "credits",
        allowances: allowancesOf(testCatalog, "credits")!,
        price,
        credits: creditsTerms.credits,
        creditsExpire: creditsTerms.creditsExpire,
        rates: creditsTerms.rates,
      }),
    );
    const view = Option.getOrNull(yield* entitlements.query(ref, { atLeast: receipt }));
    yield* waitForProjection(store, account.id, view);

    const track = yield* Track();
    yield* track({ account: account.id, feature: "ai", amount: 100, dimension: "gpt-large" });

    const check = yield* CheckInProcess();
    // 1,000 credits gone, 49,000 left; a big-model call costs 10.
    const granted = yield* check({
      account: account.id,
      feature: "ai",
      amount: 1,
      dimension: "gpt-large",
    });
    expect(granted.allowed).toBe(true);
    expect(granted.remaining).toBe(49_000);

    // 5,000 units of the big model cost 50,000: more than the pool holds.
    const refused = yield* check({
      account: account.id,
      feature: "ai",
      amount: 5_000,
      dimension: "gpt-large",
    });
    expect(refused.allowed).toBe(false);
    // The default rate prices the same request at 5,000, which fits.
    const cheap = yield* check({ account: account.id, feature: "ai", amount: 5_000 });
    expect(cheap.allowed).toBe(true);

    // The row carries the card and the pool, so the edge prices it the same way.
    const readModel = yield* CheckReadModel();
    expect(
      yield* readModel({
        account: account.id,
        feature: "ai",
        amount: 5_000,
        dimension: "gpt-large",
      }),
    ).toEqual(refused);

    const row = yield* waitForProjection(
      store,
      account.id,
      Option.getOrNull(yield* entitlements.query(ref)),
    );
    expect(row?.credits).toBe(49_000);
    expect(row?.features.ai?.creditRates).toEqual({ default: 1, "gpt-large": 10 });
    expect(row?.features.ai?.remaining).toBe(49_000);
    expect(row?.features.ai?.used).toBe(1_000);
    // The pool is one number, not a per-feature balance.
    expect(Schema.is(Schema.Struct({ credits: Schema.Int }))(row)).toBe(true);
  }).pipe(Effect.provide(World)),
);
