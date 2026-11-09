import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Hold, UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };

const compute = feature({
  id: "compute",
  rateCard: {
    default: 1,
    rules: [{ match: { size: "large" }, credits: 16 }],
    multipliers: [{ match: { lifecycle: "spot" }, factor: 0.3 }],
  },
});

const proTier = tier({
  id: "pro",
  price,
  credits: 1_000,
  grants: [allowance(messages, { included: 10 })],
});

const testCatalog = Effect.runSync(catalog({ features: [compute, messages], tiers: [proTier] }));
const terms = planTermsOf(testCatalog, "pro")!;
const account = Subscription.ref("acct_rate_card");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      credits: 1_000,
      creditsExpire: "period",
      rates: terms.rates,
      tier: "pro",
      allowances: terms.allowances,
      price,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "pro",
      credits: 1_000,
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
      statusAfter: "active",
    }),
  ),
] as const;

it.effect(
  "prices a usage event by its properties: a rule picks the rate, a multiplier changes it",
  () =>
    story(
      ...subscribed,
      // A large spot machine: the rule sets 16 credits, the multiplier takes 30%.
      Story.when(
        account,
        new TrackUsage({
          feature: "compute",
          amount: 10,
          properties: { size: "large", lifecycle: "spot" },
        }),
      ),
      Story.then(
        account,
        new UsageRecorded({
          feature: "compute",
          amount: 10,
          cost: 50,
          creditsAfter: 950,
          usedAfter: 50,
          remainingAfter: 950,
        }),
      ),
    ),
);

it.effect("a hold captures the rate its properties priced, and settles at that rate", () =>
  story(
    ...subscribed,
    Story.when(
      account,
      new Hold({
        holdId: "turn",
        feature: "compute",
        amount: 4,
        properties: { size: "large" },
      }),
    ),
    Story.then(
      account,
      new UsageReserved({
        holdId: "turn",
        feature: "compute",
        amount: 4,
        rate: 16,
        cost: 64,
        at: start,
        expiresAt: DateTime.add(start, { minutes: 15 }),
        remainingAfter: 936,
      }),
    ),
  ),
);
