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
import { Payments, paymentsRouter, type MoneyProvider } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import {
  AttachProviderRef,
  ProviderRefAttached,
} from "../../src/Subscription/AttachProviderRef.command.ts";
import { ChangeTier, TierChanged } from "../../src/Subscription/ChangeTier.command.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import {
  PeriodCloseUsage,
  billableLines,
  periodUsageCommandId,
} from "../../src/Subscription/PeriodCloseUsage.policy.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const unitPrice = { amount: 2, currency: "usd" } as const;
const price = { amount: 1900, currency: "usd", interval: "month" as const };

const meteredTier = tier({
  id: "metered",
  price,
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      unitPrice,
    }),
  ],
});

// The same tier after a price change: one unit past the grant now costs 3
// minor units instead of 2, and the grant itself is untouched.
const retunedTier = tier({
  id: "retuned",
  price,
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      unitPrice: { amount: 3, currency: "usd" },
    }),
  ],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [meteredTier, retunedTier] }),
);

const metered = allowancesOf(testCatalog, "metered")!;
const retuned = allowancesOf(testCatalog, "retuned")!;
const repriced = { amount: 3, currency: "usd" } as const;
const account = Subscription.ref("acct_period_usage");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "metered",
      allowances: metered,
      price,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "metered",
      allowances: metered,
      remaining: { messages: 100 },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price,
      statusAfter: "active",
    }),
  ),
  Story.when(account, new AttachProviderRef({ provider: "memory", refs: { customer: "cus_1" } })),
  Story.then(account, new ProviderRefAttached({ provider: "memory", refs: { customer: "cus_1" } })),
] as const;

const closed = [
  new PeriodClosed({
    periodStart: start,
    periodEnd: monthLater,
    nextPeriodStart: monthLater,
    nextPeriodEnd: march,
    statusAfter: "active",
    standingAfter: "good",
    cancelAtPeriodEndAfter: false,
  }),
  new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
  new CreditsExpired({ amount: 0, balanceAfter: 0 }),
] as const;

const storyWith = (player: MoneyProvider) =>
  Story.make(PaykitModel, {
    layer: PaykitHandlers.pipe(
      Layer.provide(MemoryBillingReadStore),
      Layer.provideMerge(paymentsRouter(player)),
    ),
  });

it.effect("reports the closing period's billable units once, at the close", () => {
  const player = PaymentsMemory();
  const story = storyWith(player);
  const commandId = periodUsageCommandId(start, monthLater);

  return Effect.gen(function* () {
    yield* story(
      ...subscribed,
      // 150 used, 100 included: the vendor is sent 50 billable units, not 150.
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
          charge: 100,
          billedAfter: 100,
          unitPrice,
          // The part of the 150 past the 100 included: what the vendor owes.
          billable: 50,
        }),
      ),
      Story.clock(monthLater),
      Story.call(Payments.reportUsage, {
        account: "acct_period_usage",
        lines: [{ feature: "messages", unitPrice, quantity: 50 }],
        commandId,
      }),
      Story.returned(Payments.reportUsage, {}),
      Story.then(account, ...closed),
    );

    expect(player.reports).toEqual([
      {
        account: "acct_period_usage",
        periodStart: start,
        periodEnd: monthLater,
        lines: [{ feature: "messages", unitPrice, quantity: 50 }],
        commandId,
      },
    ]);
  });
});

it.effect("splits one period's report across the prices its units were recorded at", () => {
  const player = PaymentsMemory();
  const story = storyWith(player);
  const commandId = periodUsageCommandId(start, monthLater);

  return Effect.gen(function* () {
    yield* story(
      ...subscribed,
      // 50 past the grant, billed at the first price.
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
          charge: 100,
          billedAfter: 100,
          unitPrice,
          billable: 50,
        }),
      ),
      // The price changes mid-period. A billed allowance is past its count by
      // design, so the change is allowed and the usage already recorded stays
      // where it is — priced at the price it was recorded at.
      Story.when(
        account,
        new ChangeTier({
          tier: "retuned",
          allowances: retuned,
          price,
          credits: 0,
          creditsExpire: "period",
          rates: {},
          proration: { currency: "usd", credit: 1900, charge: 1900, due: 0 },
        }),
      ),
      Story.then(
        account,
        new TierChanged({
          tier: "retuned",
          allowances: retuned,
          remaining: { messages: -50 },
          credits: 0,
          creditsExpire: "period",
          rates: {},
          currency: "usd",
          interval: "month",
          priceBefore: price,
          priceAfter: price,
          proration: { currency: "usd", credit: 1900, charge: 1900, due: 0 },
        }),
      ),
      // 50 more units, all past the grant: they bill at the second price.
      Story.when(account, new TrackUsage({ feature: "messages", amount: 50 })),
      Story.then(
        account,
        new UsageRecorded({
          feature: "messages",
          amount: 50,
          cost: 0,
          creditsAfter: 0,
          usedAfter: 200,
          remainingAfter: -100,
          charge: 150,
          billedAfter: 250,
          unitPrice: repriced,
          billable: 50,
        }),
      ),
      Story.clock(monthLater),
      Story.call(Payments.reportUsage, {
        account: "acct_period_usage",
        lines: [
          { feature: "messages", unitPrice, quantity: 50 },
          { feature: "messages", unitPrice: repriced, quantity: 50 },
        ],
        commandId,
      }),
      Story.returned(Payments.reportUsage, {}),
      Story.then(account, ...closed),
    );

    expect(player.reports).toHaveLength(1);
    expect(player.reports[0]!.lines).toEqual([
      { feature: "messages", unitPrice, quantity: 50 },
      { feature: "messages", unitPrice: repriced, quantity: 50 },
    ]);
  });
});

it.effect("reports nothing when the closing period used only its included units", () => {
  const player = PaymentsMemory();
  const story = storyWith(player);

  return Effect.gen(function* () {
    yield* story(
      ...subscribed,
      Story.when(account, new TrackUsage({ feature: "messages", amount: 60 })),
      Story.then(
        account,
        new UsageRecorded({
          feature: "messages",
          amount: 60,
          cost: 0,
          creditsAfter: 0,
          usedAfter: 60,
          remainingAfter: 40,
          charge: 0,
          billedAfter: 0,
          unitPrice,
          billable: 0,
        }),
      ),
      Story.clock(monthLater),
      Story.then(account, ...closed),
    );
    expect(player.reports).toEqual([]);
  });
});

it.effect("reports nothing for an account with no vendor customer", () => {
  const player = PaymentsMemory();
  const story = storyWith(player);

  return Effect.gen(function* () {
    yield* story(
      Story.provide(Actor, system("test")),
      Story.clock(start),
      Story.when(
        account,
        new Subscribe({
          tier: "metered",
          allowances: metered,
          price,
          credits: 0,
          creditsExpire: "period",
          rates: {},
        }),
      ),
      Story.then(
        account,
        new SubscriptionActivated({
          tier: "metered",
          allowances: metered,
          remaining: { messages: 100 },
          credits: 0,
          creditsExpire: "period",
          rates: {},
          periodStart: start,
          periodEnd: monthLater,
          anchorTz: "UTC",
          interval: "month",
          currency: "usd",
          price,
          statusAfter: "active",
        }),
      ),
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
          charge: 100,
          billedAfter: 100,
          unitPrice,
          billable: 50,
        }),
      ),
      // No provider reference: there is no customer whose meter could receive
      // the usage, so the close is local-only and `Verify` reports the drift.
      Story.clock(monthLater),
      Story.then(account, ...closed),
    );
    expect(player.reports).toEqual([]);
  });
});

it.effect("a provider without a meter fails the close instead of billing silently", () => {
  const story = storyWith(PaymentsManual());

  return story(
    ...subscribed,
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
        charge: 100,
        billedAfter: 100,
        unitPrice,
        billable: 50,
      }),
    ),
    Story.clock(monthLater),
    Story.then(account, ...closed),
  ).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => expect(String(failure.message)).toContain("ProviderCapabilityMissing")),
    ),
    Effect.asVoid,
  );
});

it("reports one line per price, and skips features with no price", () => {
  expect(
    billableLines({
      messages: {
        included: 100,
        used: 150,
        reserved: 0,
        remaining: -50,
        carried: 0,
        allowed: true,
        overage: "bill",
        resets: "month",
        resetsAt: monthLater,
        unitPrice,
        billed: 100,
        priced: {
          "usd:2": { unitPrice, quantity: 50 },
          "usd:3": { unitPrice: { amount: 3, currency: "usd" }, quantity: 10 },
        },
      },
      storage: {
        included: 10,
        used: 3,
        reserved: 0,
        remaining: 7,
        carried: 0,
        allowed: true,
        overage: "block",
        resets: "month",
        resetsAt: monthLater,
      },
    }),
  ).toEqual([
    { feature: "messages", unitPrice, quantity: 50 },
    { feature: "messages", unitPrice: { amount: 3, currency: "usd" }, quantity: 10 },
  ]);
});

it("names the report by the period, so a retry is the same idempotency key", () => {
  expect(periodUsageCommandId(start, monthLater)).toBe(
    `period-usage:${DateTime.toEpochMillis(start)}:${DateTime.toEpochMillis(monthLater)}`,
  );
  expect(periodUsageCommandId(start, monthLater)).toBe(periodUsageCommandId(start, monthLater));
  expect(periodUsageCommandId(start, monthLater)).not.toBe(periodUsageCommandId(monthLater, march));
  expect(PeriodCloseUsage.policyName).toBe("PeriodCloseUsage");
});
