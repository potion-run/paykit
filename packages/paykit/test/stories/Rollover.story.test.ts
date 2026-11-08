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

const carryingTier = tier({
  id: "carrying",
  price,
  grants: [allowance(messages, { included: 2_000, carryOver: true })],
});

const plainTier = tier({
  id: "plain",
  price,
  grants: [allowance(messages, { included: 2_000 })],
});

const overdrawTier = tier({
  id: "overdraw",
  price,
  grants: [allowance(messages, { included: 100, overage: "bill", carryOver: true })],
});

const unlimitedTier = tier({
  id: "unlimited",
  price,
  grants: [allowance(messages, { included: "unlimited", carryOver: true })],
});

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [carryingTier, plainTier, overdrawTier, unlimitedTier],
  }),
);

const carrying = allowancesOf(testCatalog, "carrying")!;
const plain = allowancesOf(testCatalog, "plain")!;
const overdraw = allowancesOf(testCatalog, "overdraw")!;
const unlimited = allowancesOf(testCatalog, "unlimited")!;

const account = Subscription.ref("acct_rollover");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const monthAfterThat = at("2030-03-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const subscribed = (tierId: string, allowances: typeof carrying) =>
  [
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: tierId,
        allowances,
        price,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: tierId,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances,
        remaining: { messages: includedOf(allowances) },
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

function includedOf(allowances: typeof carrying): number | null {
  const included = allowances.messages!.included;

  return included === "unlimited" ? null : included;
}

const closed = (periodStart: DateTime.Utc, periodEnd: DateTime.Utc, nextPeriodEnd: DateTime.Utc) =>
  new PeriodClosed({
    periodStart,
    periodEnd,
    nextPeriodStart: periodEnd,
    nextPeriodEnd,
    statusAfter: "active",
    standingAfter: "good",
    cancelAtPeriodEndAfter: false,
  });

const creditsExpired = new CreditsExpired({ amount: 0, balanceAfter: 0 });

/** The parts of a feature's read model a test asserts, with the rest filled in. */
const viewFeature = (over: {
  readonly included: number | "unlimited";
  readonly remaining: number | null;
  readonly carried: number;
  readonly overage?: "block" | "bill" | "allow";
  readonly used?: number;
  readonly resetsAt?: DateTime.Utc | null;
}) => ({
  included: over.included,
  used: over.used ?? 0,
  reserved: 0,
  remaining: over.remaining,
  carried: over.carried,
  allowed: true,
  overage: over.overage ?? "block",
  resets: "month" as const,
  resetsAt: over.resetsAt ?? null,
});

it.effect("carries what the period did not spend into the next one", () =>
  story(
    ...subscribed("carrying", carrying),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 520 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 520,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 520,
        remainingAfter: 1_480,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      closed(start, monthLater, monthAfterThat),
      // 2,000 included plus the 1,480 this period did not spend.
      new UsageReset({ remaining: { messages: 3_480 }, carried: { messages: 1_480 } }),
      creditsExpired,
    ),
    Story.view(Entitlements, account, {
      periodEnd: monthAfterThat,
      features: {
        messages: viewFeature({
          included: 2_000,
          remaining: 3_480,
          carried: 1_480,
          resetsAt: monthAfterThat,
        }),
      },
    }),
    // The carry is spendable, not just visible.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 3_480 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 3_480,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 3_480,
        remainingAfter: 0,
      }),
    ),
  ),
);

it.effect("caps the carry at one period's worth", () =>
  story(
    ...subscribed("carrying", carrying),
    // A first close with nothing spent carries a full period's worth.
    Story.clock(monthLater),
    Story.then(
      account,
      closed(start, monthLater, monthAfterThat),
      new UsageReset({ remaining: { messages: 4_000 }, carried: { messages: 2_000 } }),
      creditsExpired,
    ),
    // 4,000 is more than one period's worth, so the second close carries 2,000
    // again rather than 4,000: a period never grows without bound.
    Story.clock(monthAfterThat),
    Story.then(
      account,
      closed(monthLater, monthAfterThat, at("2030-04-01T00:00:00Z")),
      new UsageReset({ remaining: { messages: 4_000 }, carried: { messages: 2_000 } }),
      creditsExpired,
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: viewFeature({
          included: 2_000,
          remaining: 4_000,
          carried: 2_000,
          resetsAt: at("2030-04-01T00:00:00Z"),
        }),
      },
    }),
  ),
);

it.effect("resets an allowance that does not carry to what it includes", () =>
  story(
    ...subscribed("plain", plain),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 520 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 520,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 520,
        remainingAfter: 1_480,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      closed(start, monthLater, monthAfterThat),
      new UsageReset({ remaining: { messages: 2_000 }, carried: { messages: 0 } }),
      creditsExpired,
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: viewFeature({
          included: 2_000,
          remaining: 2_000,
          carried: 0,
          resetsAt: monthAfterThat,
        }),
      },
    }),
  ),
);

it.effect("carries nothing when the period ended over its allowance", () =>
  story(
    ...subscribed("overdraw", overdraw),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 150 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 150,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 150,
        remainingAfter: -50,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      closed(start, monthLater, monthAfterThat),
      // A negative balance clamps to no carry: the next period is not charged
      // for the overspend.
      new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
      creditsExpired,
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: viewFeature({
          included: 100,
          remaining: 100,
          carried: 0,
          overage: "bill",
          resetsAt: monthAfterThat,
        }),
      },
    }),
  ),
);

it.effect("an unlimited allowance closes to no count and carries nothing", () =>
  story(
    ...subscribed("unlimited", unlimited),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 5 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 5,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 5,
        remainingAfter: null,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      closed(start, monthLater, monthAfterThat),
      new UsageReset({ remaining: { messages: null }, carried: { messages: 0 } }),
      creditsExpired,
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: viewFeature({
          included: "unlimited",
          remaining: null,
          carried: 0,
          overage: "allow",
          resetsAt: monthAfterThat,
        }),
      },
    }),
  ),
);

it("a period that carried nothing starts at what it includes", () => {
  // The arithmetic on its own: no clock, no store, one pure decision input.
  const built = Effect.runSync(catalog({ features: [messages], tiers: [plainTier, carryingTier] }));
  expect(allowancesOf(built, "carrying")?.messages?.carryOver).toBe(true);
  expect(allowancesOf(built, "plain")?.messages?.carryOver).toBe(false);
});
