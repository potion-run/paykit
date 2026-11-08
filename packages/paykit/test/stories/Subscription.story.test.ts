import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, type Catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import {
  ChangeTier,
  DowngradeBelowUsage,
  TierChanged,
} from "../../src/Subscription/ChangeTier.command.ts";
import { CurrencyMismatch } from "../../src/Subscription/CurrencyMismatch.rejection.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { StartTrial, TrialStarted } from "../../src/Subscription/StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "../../src/Subscription/TierNotInCatalog.rejection.ts";
import {
  AllowanceExceeded,
  TrackUsage,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { TrialAlreadyUsed } from "../../src/Subscription/TrialAlreadyUsed.rejection.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const scaleTier = tier({
  id: "scale",
  price: { amount: 9900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5000, overage: "block" })],
});

export const testCatalog: Catalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);

const allowances = (id: string) => {
  const found = allowancesOf(testCatalog, id);

  if (found === null) throw new Error(`test catalog is missing ${id}`);

  return found;
};

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const account = Subscription.ref("acct_1");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const freeAllowances = allowances("free");
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const proAllowances = allowances("pro");
const scaleAllowances = allowances("scale");

const activatedFree = new SubscriptionActivated({
  tier: "free",
  credits: 0,
  creditsExpire: "period",
  rates: {},
  allowances: freeAllowances,
  remaining: { messages: 100 },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  statusAfter: "active",
});

it.effect("subscribes to a free tier and exposes its entitlements", () =>
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
        allowances: freeAllowances,
      }),
    ),
    Story.then(account, activatedFree),
    Story.state(account, { _tag: "Subscribed", tier: "free", status: "active" }),
    Story.view(Entitlements, account, {
      account: "acct_1",
      tier: "free",
      standing: "good",
      features: {
        messages: {
          included: 100,
          used: 0,
          reserved: 0,
          carried: 0,
          allowed: true,
          remaining: 100,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
    Story.view(BillingState, account, {
      account: "acct_1",
      tier: "free",
      status: "active",
      cancelAtPeriodEnd: false,
    }),
  ),
);

it.effect("records usage and refuses past a blocking allowance", () =>
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
        allowances: freeAllowances,
      }),
    ),
    Story.then(account, activatedFree),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 40 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 40,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 40,
        remainingAfter: 60,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 100,
          used: 40,
          reserved: 0,
          carried: 0,
          allowed: true,
          remaining: 60,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 61 })),
    Story.rejected(
      new AllowanceExceeded({
        feature: "messages",
        included: 100,
        used: 40,
        requested: 61,
        remaining: 60,
      }),
    ),
  ),
);

it.effect("dedupes a usage fact by its key", () =>
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
        allowances: freeAllowances,
      }),
    ),
    Story.then(account, activatedFree),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 10,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 10,
        remainingAfter: 90,
        dedupeKey: "req-1",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" })),
    Story.then(account),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 100,
          used: 10,
          reserved: 0,
          carried: 0,
          allowed: true,
          remaining: 90,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
  ),
);

it.effect("bills overage past an included amount when the allowance says bill", () =>
  story(
    Story.provide(Actor, system()),
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
    Story.then(
      account,
      new SubscriptionActivated({
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
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 2500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 2500,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 2500,
        remainingAfter: -500,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 2000,
          used: 2500,
          reserved: 0,
          carried: 0,
          allowed: true,
          remaining: -500,
          overage: "bill",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
  ),
);

it.effect("starts one trial per account", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        remaining: { messages: 2000 },
        periodStart: start,
        periodEnd: at("2030-01-15T00:00:00Z"),
        anchorTz: "UTC",
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        statusAfter: "trialing",
      }),
    ),
    Story.view(Entitlements, account, { status: "trialing", standing: "good" }),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        trialEndsAt: at("2030-02-15T00:00:00Z"),
      }),
    ),
    Story.rejected(new TrialAlreadyUsed({ account: "acct_1" })),
  ),
);

it.effect("refuses a tier the catalog does not carry", () =>
  story(
    Story.provide(Actor, system()),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "nope",
        allowances: {},
      }),
    ),
    Story.rejected(new TierNotInCatalog({ tier: "nope" })),
  ),
);

it.effect("changes tier and refuses a downgrade below usage", () =>
  story(
    Story.provide(Actor, system()),
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
    Story.then(
      account,
      new SubscriptionActivated({
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
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 900 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 900,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 900,
        remainingAfter: 1100,
      }),
    ),
    Story.when(
      account,
      new ChangeTier({
        tier: "scale",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: scaleAllowances,
        price: { amount: 9900, currency: "usd", interval: "month" },
        // The proration the model works out at the period's start: the whole
        // period is unused, so it credits the old price and charges the new.
        proration: { currency: "usd", credit: 1900, charge: 9900, due: 8000 },
      }),
    ),
    Story.then(
      account,
      new TierChanged({
        tier: "scale",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: scaleAllowances,
        remaining: { messages: 4100 },
        currency: "usd",
        interval: "month",
        priceBefore: proPrice,
        priceAfter: { amount: 9900, currency: "usd", interval: "month" },
        proration: { currency: "usd", credit: 1900, charge: 9900, due: 8000 },
      }),
    ),
    Story.view(Entitlements, account, {
      tier: "scale",
      features: {
        messages: {
          included: 5000,
          used: 900,
          reserved: 0,
          carried: 0,
          allowed: true,
          remaining: 4100,
          overage: "block",
          resets: "month",
          resetsAt: monthLater,
        },
      },
    }),
    Story.when(
      account,
      new ChangeTier({
        tier: "free",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: freeAllowances,
      }),
    ),
    Story.rejected(new DowngradeBelowUsage({ feature: "messages", included: 100, used: 900 })),
  ),
);

it.effect("carries proration on a mid-cycle tier change for audit", () =>
  story(
    Story.provide(Actor, system()),
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
    Story.then(
      account,
      new SubscriptionActivated({
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
      }),
    ),
    Story.when(
      account,
      new ChangeTier({
        tier: "scale",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: scaleAllowances,
        price: { amount: 9900, currency: "usd", interval: "month" },
        proration: { currency: "usd", credit: 1900, charge: 9900, due: 8000 },
      }),
    ),
    Story.then(
      account,
      new TierChanged({
        tier: "scale",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: scaleAllowances,
        remaining: { messages: 5000 },
        currency: "usd",
        interval: "month",
        priceBefore: proPrice,
        priceAfter: { amount: 9900, currency: "usd", interval: "month" },
        proration: { currency: "usd", credit: 1900, charge: 9900, due: 8000 },
      }),
    ),
  ),
);

it.effect("refuses a currency change", () =>
  story(
    Story.provide(Actor, system()),
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
    Story.then(
      account,
      new SubscriptionActivated({
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
      }),
    ),
    Story.when(
      account,
      new ChangeTier({
        tier: "scale",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: scaleAllowances,
        price: { amount: 9900, currency: "eur", interval: "month" },
      }),
    ),
    Story.rejected(new CurrencyMismatch({ expected: "usd", actual: "eur" })),
  ),
);

it("the model is well defined", () => {
  expect(Domain.verify(PaykitModel)).toEqual([]);
});
