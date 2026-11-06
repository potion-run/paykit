import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { AllowanceReset, ResetAllowance } from "../../src/Subscription/ResetAllowance.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };

/** A daily allowance on a monthly plan: the period does not own its boundary. */
const dailyTier = tier({
  id: "daily",
  price,
  grants: [allowance(messages, { included: 10, resets: "day" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [dailyTier] }));
const terms = tierTermsOf(testCatalog, "daily")!;
const account = Subscription.ref("acct_daily");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const dayLater = at("2030-01-02T00:00:00Z");
const dayAfterThat = at("2030-01-03T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

it.effect("a daily allowance resets at its own boundary, not the period's", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: terms.rates,
        tier: "daily",
        allowances: terms.allowances,
        price,
      }),
    ),
    // The activation records the daily boundary; the monthly period end is not
    // this allowance's boundary.
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "daily",
        credits: 0,
        creditsExpire: "period",
        rates: terms.rates,
        allowances: terms.allowances,
        remaining: { messages: 10 },
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        price,
        resetAt: { messages: dayLater },
        statusAfter: "active",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 4 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 4,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 4,
        remainingAfter: 6,
      }),
    ),
    Story.clock(dayLater),
    Story.when(account, new ResetAllowance({ feature: "messages", at: dayLater })),
    Story.then(
      account,
      new AllowanceReset({
        feature: "messages",
        remaining: 10,
        carried: 0,
        resetAt: dayAfterThat,
      }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: monthLater,
      features: {
        messages: {
          included: 10,
          used: 0,
          reserved: 0,
          remaining: 10,
          carried: 0,
          allowed: true,
          overage: "block",
          resets: "day",
          resetsAt: dayAfterThat,
        },
      },
    }),
  ),
);
