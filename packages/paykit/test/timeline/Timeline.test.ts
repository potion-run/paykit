import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import { PeriodClosed } from "../../src/Subscription/ClosePeriod.command.ts";
import { CreditsExpired } from "../../src/Subscription/ClosePeriod.command.ts";
import { TrialExtended } from "../../src/Subscription/ExtendTrial.command.ts";
import { CreditsGranted } from "../../src/Subscription/GrantCredits.command.ts";
import { UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { CreditsPurchased } from "../../src/Subscription/PurchaseCredits.command.ts";
import { PaymentRecorded } from "../../src/Subscription/RecordPayment.command.ts";
import { RefundRecorded } from "../../src/Subscription/Refund.command.ts";
import { UsageSettled } from "../../src/Subscription/SettleHold.command.ts";
import { SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import {
  type AccountEvent,
  type TimelineInput,
  appendTimeline,
  initialTimeline,
  timelineOf,
} from "../../src/Timeline.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const monthAfterThat = at("2030-03-01T00:00:00Z");

const input = (seq: number, event: AccountEvent, when = start): TimelineInput => ({
  event,
  envelope: { seq, at: when },
});

const activated = new SubscriptionActivated({
  tier: "pro",
  allowances: {},
  remaining: {},
  credits: 1_000,
  creditsExpire: "period",
  rates: {},
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  statusAfter: "active",
});

const script = [
  input(1, activated),
  // 150 counted units, 100 included, billed at 2 minor units each.
  input(
    2,
    new UsageRecorded({
      feature: "messages",
      amount: 150,
      cost: 0,
      creditsAfter: 1_000,
      usedAfter: 150,
      remainingAfter: -50,
      charge: 100,
      billedAfter: 100,
      unitPrice: { amount: 2, currency: "usd" },
      billable: 50,
    }),
  ),
  // 20 units of a credit-priced feature.
  input(
    3,
    new UsageRecorded({
      feature: "ai",
      amount: 20,
      cost: 20,
      creditsAfter: 980,
      usedAfter: 20,
      remainingAfter: 980,
    }),
  ),
  input(
    4,
    new UsageReserved({
      holdId: "hold_1",
      feature: "ai",
      amount: 10,
      rate: 1,
      cost: 10,
      at: start,
      expiresAt: monthLater,
      remainingAfter: 960,
    }),
  ),
  // The hold becomes 8 units of work; the other 2 return in the same command.
  input(
    5,
    new UsageRecorded({
      feature: "ai",
      amount: 8,
      cost: 8,
      creditsAfter: 972,
      usedAfter: 28,
      remainingAfter: 972,
    }),
  ),
  input(
    6,
    new UsageSettled({
      holdId: "hold_1",
      feature: "ai",
      amount: 8,
      released: 2,
      cost: 10,
      remainingAfter: 972,
    }),
  ),
  input(
    7,
    new CreditsPurchased({
      tier: "pack",
      amount: 500,
      price: { amount: 4_900, currency: "usd", interval: "month" },
      invoiceId: "in_1",
      balanceAfter: 1_472,
      prepaidAfter: 500,
    }),
  ),
  input(8, new CreditsGranted({ amount: 50, balanceAfter: 1_522 })),
  input(9, new PaymentRecorded({ amount: 1_900, currency: "usd", statusAfter: "active" })),
  input(
    10,
    new PeriodClosed({
      periodStart: start,
      periodEnd: monthLater,
      nextPeriodStart: monthLater,
      nextPeriodEnd: monthAfterThat,
      statusAfter: "active",
      standingAfter: "good",
      cancelAtPeriodEndAfter: false,
    }),
    monthLater,
  ),
  input(11, new CreditsExpired({ amount: 1_000, balanceAfter: 522 }), monthLater),
  input(
    12,
    new RefundRecorded({
      chargeId: "ch_1",
      refundId: "re_1",
      amount: 1_900,
      currency: "usd",
      commandId: "refund-1",
      reason: "duplicate order",
      refundedAfter: 1_900,
    }),
    monthLater,
  ),
];

it("folds the log into one entry per billing fact, in order", () => {
  const timeline = timelineOf(script);
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "started",
    "usage",
    "usage",
    "hold",
    "usage",
    "settle",
    "credit-purchase",
    "credit-grant",
    "payment",
    "period",
    "credit-expire",
    "refund",
  ]);
  expect(timeline.entries[0]?.tier).toBe("pro");
  expect(timeline.entries[1]?.charge).toBe(100);
  expect(timeline.entries[3]?.holdId).toBe("hold_1");
  expect(timeline.entries[5]?.holdId).toBe("hold_1");
  expect(timeline.entries[6]?.invoiceId).toBe("in_1");
  // Money going back is its own entry: an amount and a currency, not a
  // negative payment and not a credit move.
  expect(timeline.entries[11]?.refundId).toBe("re_1");
  expect(timeline.entries[11]?.charge).toBe(1_900);
  expect(timeline.entries[11]?.reason).toBe("duplicate order");
  expect(timeline.lastSeq).toBe(12);
});

it("rolls each period up per feature, per credit move, and per hold", () => {
  const timeline = timelineOf(script);
  const [january, february] = timeline.periods;
  expect(january?.start).toEqual(start);
  expect(january?.features.messages).toEqual({
    units: 150,
    credits: 0,
    charge: 100,
    held: 0,
    settled: 0,
    released: 0,
  });
  expect(january?.features.ai).toEqual({
    units: 28,
    credits: 28,
    charge: 0,
    held: 10,
    settled: 8,
    released: 2,
  });
  expect(january?.credits).toEqual({
    granted: 1_050,
    purchased: 500,
    spent: 28,
    expired: 0,
    balanceAfter: 1_522,
  });
  // The close opens the next period with the pool it ended on; the expiry the
  // close emits is after that boundary, so it belongs to the new period.
  expect(february?.credits).toEqual({
    granted: 0,
    purchased: 0,
    spent: 0,
    expired: 1_000,
    balanceAfter: 522,
  });
});

it("does not count a redelivered event twice", () => {
  const once = timelineOf(script);
  const again = timelineOf([...script, script[4]!]);
  expect(again).toEqual(once);
  expect(appendTimeline(once, script[4]!)).toBe(once);
});

it("keeps a purchase made before any plan outside a period", () => {
  const timeline = timelineOf([
    input(
      1,
      new CreditsPurchased({
        tier: "pack",
        amount: 500,
        balanceAfter: 500,
        prepaidAfter: 500,
      }),
    ),
    input(2, activated),
  ]);
  expect(timeline.periods.length).toBe(1);
  expect(timeline.entries[0]?.periodStart).toBeUndefined();
  expect(timeline.entries[1]?.periodStart).toEqual(start);
});

it("moves a trial's period end without inventing a billing entry", () => {
  const timeline = timelineOf([
    input(1, activated),
    input(2, new TrialExtended({ trialEndsAt: monthAfterThat, periodEnd: monthAfterThat })),
  ]);
  expect(timeline.entries.map((entry) => entry.kind)).toEqual(["started"]);
  expect(timeline.periods[0]?.end).toEqual(monthAfterThat);
  expect(timeline.lastSeq).toBe(2);
});

it("has no entries before the first event", () => {
  expect(timelineOf([])).toEqual(initialTimeline);
});
