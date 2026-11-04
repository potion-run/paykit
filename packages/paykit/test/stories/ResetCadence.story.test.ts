import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages, seats } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

const teamTier = tier({
  id: "team",
  price,
  grants: [
    allowance(messages, { included: 100 }),
    // Seats are a standing grant: a period close must not replenish them.
    allowance(seats, { included: 5, resets: "never" }),
  ],
});

const testCatalog = Effect.runSync(catalog({ features: [messages, seats], tiers: [teamTier] }));
const team = allowancesOf(testCatalog, "team")!;

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});
const account = Subscription.ref("acct_reset");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

it.effect("a never-reset allowance keeps its usage across a period close", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "team",
        allowances: team,
        price,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "team",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: team,
        remaining: { messages: 100, seats: 5 },
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        price,
        statusAfter: "active",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 20 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 20,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 20,
        remainingAfter: 80,
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "seats", amount: 2 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "seats",
        amount: 2,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 2,
        remainingAfter: 3,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: march,
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({
        remaining: { messages: 100, seats: 3 },
        carried: { messages: 0, seats: 0 },
        kept: { seats: true },
      }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: march,
      features: {
        messages: {
          included: 100,
          used: 0,
          reserved: 0,
          remaining: 100,
          carried: 0,
          allowed: true,
          overage: "block",
          resets: "month",
          resetsAt: march,
        },
        seats: {
          included: 5,
          used: 2,
          reserved: 0,
          remaining: 3,
          carried: 0,
          allowed: true,
          overage: "block",
          resets: "never",
          resetsAt: null,
        },
      },
    }),
  ),
);
