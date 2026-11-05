import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, creditRatesOf } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };
const packPrice = { amount: 9_900, currency: "usd", interval: "month" as const };
const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });

const packTier = tier({
  id: "credits_1k",
  kind: "one_off",
  price: packPrice,
  credits: 1_000,
  grants: [],
});
const planTier = tier({
  id: "pro",
  price,
  credits: 100,
  grants: [allowance(messages, { included: 100 })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages, ai], tiers: [planTier, packTier] }),
);
const rates = creditRatesOf(testCatalog);
const plan = { allowances: { messages: planTier.grants[0]! }, credits: 100 };
const account = Subscription.ref("acct_prepaid_only");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

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

const bought = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new PurchaseCredits({ tier: "credits_1k", amount: 1_000, price: packPrice, rates }),
  ),
  Story.then(
    account,
    new CreditsPurchased({
      tier: "credits_1k",
      amount: 1_000,
      price: packPrice,
      rates,
      balanceAfter: 1_000,
      prepaidAfter: 1_000,
    }),
  ),
  Story.view(Entitlements, account, {
    standing: "good",
    credits: 1_000,
    features: { ai: creditFeature({ remaining: 1_000 }) },
  }),
] as const;

it.effect("a pack can be spent before a plan exists", () =>
  story(
    ...bought,
    // One default unit costs one credit; `gpt-large` costs ten.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 100,
        cost: 100,
        creditsAfter: 900,
        usedAfter: 100,
        remainingAfter: 900,
      }),
    ),
    Story.view(Entitlements, account, {
      standing: "good",
      credits: 900,
      features: { ai: creditFeature({ remaining: 900, used: 100 }) },
    }),
    Story.view(BillingState, account, {
      account: "acct_prepaid_only",
      credits: 900,
    }),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 10, dimension: "gpt-large" })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 10,
        cost: 100,
        creditsAfter: 800,
        usedAfter: 200,
        remainingAfter: 800,
      }),
    ),
    Story.view(Entitlements, account, {
      credits: 800,
      features: { ai: creditFeature({ remaining: 800, used: 200 }) },
    }),
  ),
);

it.effect("a plan carries the pack's remaining balance into the first standing", () =>
  story(
    ...bought,
    Story.when(account, new TrackUsage({ feature: "ai", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 100,
        cost: 100,
        creditsAfter: 900,
        usedAfter: 100,
        remainingAfter: 900,
      }),
    ),
    Story.when(
      account,
      new Subscribe({
        tier: "pro",
        allowances: plan.allowances,
        price,
        credits: plan.credits,
        creditsExpire: "period",
        rates,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "pro",
        allowances: plan.allowances,
        remaining: { messages: 100 },
        credits: 1_000,
        prepaidCredits: 900,
        creditsExpire: "period",
        rates,
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        price,
        statusAfter: "active",
      }),
    ),
    // The plan's grant is 100 credits; the pack's 900 is carried, so the pool
    // is 1,000 and the previous usage starts a fresh period.
    Story.view(Entitlements, account, {
      status: "active",
      standing: "good",
      credits: 1_000,
      features: { ai: creditFeature({ remaining: 1_000 }) },
    }),
  ),
);
