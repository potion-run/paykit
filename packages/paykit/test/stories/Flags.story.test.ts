import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance, grant } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore, BillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { CheckInProcess, CheckReadModel } from "../../src/Check.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingRead } from "../../src/Subscription/BillingRead.projection.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  FeatureNotMetered,
  TrackUsage,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { Track } from "../../src/Track.ts";
import { waitForProjection } from "../support/ReadModel.ts";

const sso = feature({ id: "sso", name: "SSO", kind: "flag" });
const enterpriseTier = tier({
  id: "enterprise",
  price: { amount: 49_900, currency: "usd", interval: "month" },
  grants: [grant(sso), allowance(messages, { included: 50_000 })],
});
const basicTier = tier({ id: "basic", grants: [allowance(messages, { included: 10 })] });
const testCatalog = Effect.runSync(
  catalog({ features: [sso, messages], tiers: [basicTier, enterpriseTier] }),
);
const enterprise = allowancesOf(testCatalog, "enterprise")!;
const basic = allowancesOf(testCatalog, "basic")!;
const price = { amount: 49_900, currency: "usd", interval: "month" as const };
const account = Subscription.ref("acct_flags");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const monthAfterThat = at("2030-03-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

/** A flag is granted, so it carries no count while the meter beside it does. */
const activated = new SubscriptionActivated({
  tier: "enterprise",
  credits: 0,
  creditsExpire: "period",
  rates: {},
  allowances: enterprise,
  remaining: { sso: null, messages: 50_000 },
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
  Story.when(
    account,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "enterprise",
      allowances: enterprise,
      price,
    }),
  ),
  Story.then(account, activated),
] as const;

const flagFeature = {
  included: 1,
  used: 0,
  reserved: 0,
  carried: 0,
  remaining: null,
  allowed: true,
  overage: "allow" as const,
  resets: "never" as const,
  resetsAt: null,
};

it.effect("refuses usage against a flag, however it is recorded", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "sso", amount: 1 })),
    Story.rejected(new FeatureNotMetered({ feature: "sso" })),
    Story.when(account, new Hold({ holdId: "hold_sso", feature: "sso", amount: 1 })),
    Story.rejected(new FeatureNotMetered({ feature: "sso" })),
    // The meter beside it is untouched by any of that.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 10 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 10,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 10,
        remainingAfter: 49_990,
      }),
    ),
    Story.view(Entitlements, account, { features: { sso: flagFeature } }),
  ),
);

it.effect("closes the period with nothing to reset for the flag", () =>
  story(
    ...subscribed,
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
      new UsageReset({
        remaining: { sso: null, messages: 50_000 },
        carried: { sso: 0, messages: 0 },
      }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    // The flag keeps no counter across the boundary: nothing was spent, and
    // `remaining: null` says there is no count rather than a fresh 1.
    Story.view(Entitlements, account, {
      periodEnd: monthAfterThat,
      features: { sso: flagFeature },
    }),
  ),
);

const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

it.live("check() allows a granted flag, refuses an ungranted one, and the read model agrees", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const entitlements = yield* Entitlements;
    const inProcess = yield* CheckInProcess();

    // No grant at all: the existing missing-feature path, unchanged.
    const basicReceipt = yield* subscription.send(
      Subscription.ref(account.id),
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "basic",
        allowances: basic,
      }),
    );
    yield* entitlements.query(Subscription.ref(account.id), { atLeast: basicReceipt });
    yield* BillingRead.caughtUp(basicReceipt);
    const ungranted = yield* inProcess({ account: account.id, feature: "sso" });
    expect(ungranted.allowed).toBe(false);
    expect(ungranted.remaining).toBe(0);

    // A granted flag: allowed, with no count and no reset to wait for.
    const receipt = yield* subscription.send(
      Subscription.ref(account.id),
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "enterprise",
        allowances: enterprise,
        price,
      }),
    );
    yield* entitlements.query(Subscription.ref(account.id), { atLeast: receipt });
    yield* BillingRead.caughtUp(receipt);

    const granted = yield* inProcess({ account: account.id, feature: "sso", amount: 1_000_000 });
    expect(granted).toEqual({
      allowed: true,
      remaining: null,
      resetsAt: null,
      standing: "good",
    });

    const readModel = yield* CheckReadModel();
    expect(yield* readModel({ account: account.id, feature: "sso" })).toEqual(granted);

    // The row carries the flag's judgement, not a count it invented.
    const store = yield* BillingReadStore;
    const row = yield* waitForProjection(
      store,
      account.id,
      Option.getOrNull(yield* entitlements.query(Subscription.ref(account.id))),
    );
    expect(row?.features.sso?.allowed).toBe(true);
    expect(row?.features.sso?.remaining).toBeNull();
    expect(row?.features.sso?.used).toBe(0);
    expect(row?.features.sso?.included).toBe(1);

    // And a Track still refuses it through the binding.
    const track = yield* Track();
    const refused = yield* Effect.exit(track({ account: account.id, feature: "sso", amount: 1 }));
    expect(refused._tag).toBe("Failure");
    expect(String(refused)).toContain("FeatureNotMetered");
  }).pipe(Effect.provide(World)),
);
