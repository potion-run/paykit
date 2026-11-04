import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Allowances, type Allowance } from "../Allowance.ts";
import { Interval } from "../Tier.ts";

/** An account is the key of a Subscription. */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

/** Where a subscription is in its life. `none` only exists before activation. */
export const SubscriptionStatus = Schema.Literals([
  "trialing",
  "active",
  "grace",
  "canceled",
  "expired",
]);
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

/** How a reader should treat the account right now. */
export const Standing = Schema.Literals(["good", "grace", "blocked"]);
export type Standing = typeof Standing.Type;

/** `[start, end)` from the account's anchor and time zone. */
export const Period = Schema.Struct({
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
  anchorTz: Schema.String,
});
export type Period = typeof Period.Type;

/** A vendor's opaque ids for one account. Never read by `decide`. */
export const ProviderRefs = Schema.Struct({
  customer: Schema.optional(Schema.String),
  subscription: Schema.optional(Schema.String),
  checkout: Schema.optional(Schema.String),
});
export type ProviderRefs = typeof ProviderRefs.Type;

/** Vendor identifiers, keyed by provider, so a second provider is additive. */
export const Refs = Schema.Record(Schema.String, ProviderRefs);
export type Refs = typeof Refs.Type;

/** Per-feature usage, always a fold of `UsageRecorded`. */
export const UsageCounts = Schema.Record(Schema.String, Schema.Int);
export type UsageCounts = typeof UsageCounts.Type;

/** Per-feature remaining allowance, copied from the event that changed it. */
export const Remaining = Schema.Record(Schema.String, Schema.Int);
export type Remaining = typeof Remaining.Type;

/** What an account with no standing looks like: it may still hold checkout refs. */
export const UnsubscribedState = Schema.TaggedStruct("Unsubscribed", { refs: Refs });
export type UnsubscribedState = typeof UnsubscribedState.Type;

/** What an account that has ever had a tier looks like. */
export const SubscribedState = Schema.TaggedStruct("Subscribed", {
  tier: Schema.String,
  status: SubscriptionStatus,
  period: Period,
  interval: Interval,
  trialEndsAt: Schema.optional(Schema.DateTimeUtc),
  graceUntil: Schema.optional(Schema.DateTimeUtc),
  cancelAtPeriodEnd: Schema.Boolean,
  credits: Schema.Int,
  currency: Schema.optional(Schema.String),
  usage: UsageCounts,
  remaining: Remaining,
  allowances: Allowances,
  refs: Refs,
  trialUsed: Schema.Boolean,
  dedupeKeys: Schema.Record(Schema.String, Schema.Boolean),
  dunningAttempts: Schema.Int,
  lastClosedPeriodStart: Schema.optional(Schema.DateTimeUtc),
});
export type SubscribedState = typeof SubscribedState.Type;

/** One aggregate, keyed by account, that decides every billing command. */
export const SubscriptionState = Schema.Union([UnsubscribedState, SubscribedState]);
export type SubscriptionState = typeof SubscriptionState.Type;

/** The state an account starts in: no tier, no standing. */
export const initialSubscriptionState: SubscriptionState = { _tag: "Unsubscribed", refs: {} };

/** A subscription's status, or `none` before the first activation. */
export const statusOf = (state: SubscriptionState): SubscriptionStatus | "none" =>
  state._tag === "Subscribed" ? state.status : "none";

/** Map a status to what a caller may do with it. */
export const standingOf = (status: SubscriptionStatus | "none"): Standing => {
  switch (status) {
    case "trialing":
    case "active":
      return "good";
    case "grace":
      return "grace";
    case "canceled":
    case "expired":
    case "none":
      return "blocked";
  }
};

/** Whether `Track` may record usage in this status. Grace keeps service on. */
export const allowsUsage = (status: SubscriptionStatus | "none"): boolean =>
  status === "trialing" || status === "active" || status === "grace";

/** When an allowance next resets, or `null` for one that never does. */
export const resetsAt = (period: Period, allowance: Allowance): DateTime.Utc | null =>
  allowance.resets === "never" ? null : period.end;

/** Add one calendar month or year, keeping the account's anchor. */
export const addInterval = (at: DateTime.Utc, interval: Interval): DateTime.Utc =>
  DateTime.add(at, interval === "month" ? { months: 1 } : { years: 1 });

/** Start a period at `start` for the cadence the tier was bought with. */
export const periodFrom = (start: DateTime.Utc, interval: Interval, anchorTz = "UTC"): Period => ({
  start,
  end: addInterval(start, interval),
  anchorTz,
});

/** Sum of a feature's usage. */
export const usedOf = (state: SubscribedState, feature: string): number =>
  state.usage[feature] ?? 0;

/** A feature's remaining allowance, defaulting to what the tier included. */
export const remainingOf = (state: SubscribedState, feature: string): number => {
  const remaining = state.remaining[feature];
  if (remaining !== undefined) return remaining;
  return state.allowances[feature]?.included ?? 0;
};

/** The tick a money plane thinks in: integer minor units and a currency. */
export const Money = Schema.Struct({
  amount: Schema.Int,
  currency: Schema.String,
});
export type Money = typeof Money.Type;

/** Every event tag the Subscription aggregate can record. */
export const SUBSCRIPTION_EVENT_TAGS = [
  "TrialStarted",
  "TrialExtended",
  "SubscriptionActivated",
  "TierChanged",
  "UsageRecorded",
  "PaymentRecorded",
  "PaymentFailed",
  "GraceEntered",
  "Recovered",
  "CreditsGranted",
  "CreditsConsumed",
  "CancellationScheduled",
  "CancellationWithdrawn",
  "PeriodClosed",
  "UsageReset",
  "CreditsExpired",
  "SubscriptionExpired",
  "ProviderRefAttached",
] as const;
