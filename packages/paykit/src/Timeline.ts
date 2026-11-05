import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { isTerminalStatus } from "./Subscription/Subscription.state.ts";
import { Price } from "./Tier.ts";

/**
 * Every subscription event, as a schema. The account stream carries these in
 * order, so a consumer can decode one entry without knowing its tag first.
 */
export const AccountEvent = Schema.Union([...Subscription.definition.events]);
export type AccountEvent = typeof AccountEvent.Type;

/**
 * What an entry in a timeline is: a spend, a hold's life, a credit move, or a
 * boundary. The kind is what a console groups and colours by; the fields it
 * carries are the ones the originating event put on the log.
 */
export const TimelineKind = Schema.Literals([
  "started",
  "trial",
  "tier",
  "usage",
  "hold",
  "settle",
  "release",
  "credit-grant",
  "credit-purchase",
  "credit-spend",
  "credit-expire",
  "payment",
  "payment-failed",
  "proration",
  "period",
]);
export type TimelineKind = typeof TimelineKind.Type;

/**
 * One fact a bill is made of, stamped with the period that was open when the
 * log recorded it. Before a plan exists (a pack bought into an empty account)
 * the period fields are absent, which is the truth: the fact belongs to no
 * period yet.
 *
 * The amounts are copied from the event, never recomputed: `amount` is units,
 * `credits` is the pool, and `charge` is money in minor units, the same
 * meanings they have in the command that recorded them.
 */
export const TimelineEntry = Schema.Struct({
  /** The account event's sequence; a replay of the same event is ignored. */
  seq: Schema.Int,
  at: Schema.DateTimeUtc,
  kind: TimelineKind,
  /** The period open when this happened. Absent before a plan existed. */
  periodStart: Schema.optionalKey(Schema.DateTimeUtc),
  periodEnd: Schema.optionalKey(Schema.DateTimeUtc),
  feature: Schema.optionalKey(Schema.String),
  holdId: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.String),
  /** Units recorded, held, settled or released, in the feature's own unit. */
  amount: Schema.optionalKey(Schema.Int),
  /** Credits this entry granted, purchased, spent, expired, or a hold reserved. */
  credits: Schema.optionalKey(Schema.Int),
  /** Money this entry billed or collected, in minor units. */
  charge: Schema.optionalKey(Schema.Int),
  /** The credit pool after this entry, when it moved the pool. */
  creditsAfter: Schema.optionalKey(Schema.Int),
  /** What a purchase cost, or what a tier change now charges. */
  price: Schema.optionalKey(Price),
  /** The money's currency, on entries that carry money without a `Price`. */
  currency: Schema.optionalKey(Schema.String),
  /** The invoice an automatic top-up or a proration opened. */
  invoiceId: Schema.optionalKey(Schema.String),
  /** Why a payment failed. */
  reason: Schema.optionalKey(Schema.String),
});
export type TimelineEntry = typeof TimelineEntry.Type;

/** What one period recorded for one feature. Units and credits, never money's currency. */
export const TimelineFeature = Schema.Struct({
  /** Units recorded by usage this period. */
  units: Schema.Int,
  /** Credits those units spent (`0` on a feature counted in its own units). */
  credits: Schema.Int,
  /** Money those units billed, minor units. */
  charge: Schema.Int,
  /** Units this period's holds kept out of the allowance. */
  held: Schema.Int,
  /** Units this period's holds became usage for. */
  settled: Schema.Int,
  /** Units this period's holds returned unspent. */
  released: Schema.Int,
});
export type TimelineFeature = typeof TimelineFeature.Type;

/** What one period did to the credit pool. */
export const TimelineCredits = Schema.Struct({
  /** Credits a plan granted, including a trial's. */
  granted: Schema.Int,
  /** Credits a one-off pack bought. */
  purchased: Schema.Int,
  /** Credits spent, by metered usage and by a manual `ConsumeCredits`. */
  spent: Schema.Int,
  /** Credits a period close expired. */
  expired: Schema.Int,
  /** The pool when the period last moved it, when any event in it did. */
  balanceAfter: Schema.optionalKey(Schema.Int),
});
export type TimelineCredits = typeof TimelineCredits.Type;

/** One period's rollup, oldest first, with its per-feature and credit totals. */
export const TimelinePeriod = Schema.Struct({
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
  features: Schema.Record(Schema.String, TimelineFeature),
  credits: TimelineCredits,
});
export type TimelinePeriod = typeof TimelinePeriod.Type;

/**
 * A usage timeline: every billing fact an account's event log carries, in the
 * order it happened, plus a rollup per period. It is a fold over the log, not
 * a second log: every number in it is a field an event put there, and the raw
 * `AccountEvents` stream remains the complete record.
 */
export const UsageTimeline = Schema.Struct({
  /** Oldest first, the order the log recorded them. */
  entries: Schema.Array(TimelineEntry),
  /** Oldest first; one per period the account has had, including the open one. */
  periods: Schema.Array(TimelinePeriod),
  /** The last event sequence folded, so a redelivered event is not a second entry. */
  lastSeq: Schema.Int,
  /** Whether the last period is still open. A terminal close leaves it closed. */
  open: Schema.Boolean,
});
export type UsageTimeline = typeof UsageTimeline.Type;

/** One event to fold: the event, and the sequence and time the log stamped it with. */
export interface TimelineInput {
  readonly event: AccountEvent;
  readonly envelope: {
    readonly seq: number;
    readonly at: DateTime.Utc;
  };
}

const emptyFeature: TimelineFeature = {
  units: 0,
  credits: 0,
  charge: 0,
  held: 0,
  settled: 0,
  released: 0,
};

const emptyCredits: TimelineCredits = {
  granted: 0,
  purchased: 0,
  spent: 0,
  expired: 0,
};

/** A timeline before any event: no entries, no periods, nothing open. */
export const initialTimeline: UsageTimeline = UsageTimeline.make({
  entries: [],
  periods: [],
  lastSeq: 0,
  open: false,
});

interface OpenPeriod {
  readonly start: DateTime.Utc;
  readonly end: DateTime.Utc;
}

const sameInstant = (left: DateTime.Utc, right: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/** The period a new entry belongs to, or undefined before a plan exists or after one ends. */
const currentPeriod = (timeline: UsageTimeline): TimelinePeriod | undefined =>
  timeline.open ? timeline.periods[timeline.periods.length - 1] : undefined;

const replaceLastPeriod = (timeline: UsageTimeline, period: TimelinePeriod): UsageTimeline => ({
  ...timeline,
  periods: [...timeline.periods.slice(0, -1), period],
});

/**
 * Open a period, or move the end of the one already open at the same start.
 * A conversion repeats the start it was already on; a boundary opens a new one
 * and carries the pool's last known balance so the new period starts from it.
 */
const openPeriod = (
  timeline: UsageTimeline,
  start: DateTime.Utc,
  end: DateTime.Utc,
): UsageTimeline => {
  const current = currentPeriod(timeline);
  if (current !== undefined && sameInstant(current.start, start)) {
    return replaceLastPeriod(timeline, { ...current, end });
  }
  const previous = timeline.periods[timeline.periods.length - 1];
  const carried = previous?.credits.balanceAfter;
  return {
    ...timeline,
    open: true,
    periods: [
      ...timeline.periods,
      {
        start,
        end,
        features: {},
        credits: { ...emptyCredits, ...(carried === undefined ? {} : { balanceAfter: carried }) },
      },
    ],
  };
};

const withFeature = (
  period: TimelinePeriod,
  feature: string,
  change: Partial<TimelineFeature>,
): TimelinePeriod => ({
  ...period,
  features: {
    ...period.features,
    [feature]: { ...(period.features[feature] ?? emptyFeature), ...change },
  },
});

const withCredits = (period: TimelinePeriod, change: Partial<TimelineCredits>): TimelinePeriod => ({
  ...period,
  credits: { ...period.credits, ...change },
});

const withPeriod = (
  timeline: UsageTimeline,
  change: (period: TimelinePeriod) => TimelinePeriod,
): UsageTimeline => {
  const period = currentPeriod(timeline);
  return period === undefined ? timeline : replaceLastPeriod(timeline, change(period));
};

const appended = (timeline: UsageTimeline, entry: TimelineEntry): UsageTimeline => ({
  ...timeline,
  entries: [...timeline.entries, entry],
  lastSeq: entry.seq,
});

const stamped = (
  input: TimelineInput,
  period: OpenPeriod | null,
): Pick<TimelineEntry, "seq" | "at" | "periodStart" | "periodEnd"> => ({
  seq: input.envelope.seq,
  at: input.envelope.at,
  periodStart: period?.start,
  periodEnd: period?.end,
});

/**
 * Fold one event into a timeline. Events that move no counter (a provider ref,
 * a scheduled change not yet applied) advance `lastSeq` and add nothing, so a
 * consumer that replays the log reaches the same state as one that lived it.
 */
export const appendTimeline = (timeline: UsageTimeline, input: TimelineInput): UsageTimeline => {
  const { event, envelope } = input;
  if (envelope.seq <= timeline.lastSeq) return timeline;

  const period = currentPeriod(timeline);
  const periodOf = period === undefined ? null : period;

  switch (event._tag) {
    case "SubscriptionActivated":
    case "TrialStarted": {
      const opened = openPeriod(timeline, event.periodStart, event.periodEnd);
      const openedPeriod = currentPeriod(opened)!;
      const granted = event.credits - (event.prepaidCredits ?? 0);
      const entry: TimelineEntry = {
        ...stamped(input, openedPeriod),
        kind: event._tag === "SubscriptionActivated" ? "started" : "trial",
        tier: event.tier,
        credits: granted,
        creditsAfter: event.credits,
        ...(event.price === undefined ? {} : { price: event.price }),
      };
      return appended(
        replaceLastPeriod(
          opened,
          withCredits(openedPeriod, {
            granted: openedPeriod.credits.granted + granted,
            balanceAfter: event.credits,
          }),
        ),
        entry,
      );
    }

    case "TrialExtended": {
      // The trial's period is now longer. It moves no counter, so it is not an
      // entry; the period rollup's end is what a reader sees move.
      const current = currentPeriod(timeline);
      const extended =
        current === undefined
          ? timeline
          : replaceLastPeriod(timeline, { ...current, end: event.periodEnd });
      return { ...extended, lastSeq: envelope.seq };
    }

    case "TierChanged": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "tier",
        tier: event.tier,
        creditsAfter: event.credits,
        ...(event.priceAfter === undefined ? {} : { price: event.priceAfter }),
      };
      return appended(
        withPeriod(timeline, (value) => withCredits(value, { balanceAfter: event.credits })),
        entry,
      );
    }

    case "UsageRecorded": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "usage",
        feature: event.feature,
        amount: event.amount,
        credits: event.cost,
        creditsAfter: event.creditsAfter,
        ...(event.charge === undefined ? {} : { charge: event.charge }),
      };
      return appended(
        withPeriod(timeline, (value) => {
          const feature = value.features[event.feature] ?? emptyFeature;
          return withCredits(
            withFeature(value, event.feature, {
              units: feature.units + event.amount,
              credits: feature.credits + event.cost,
              charge: feature.charge + (event.charge ?? 0),
            }),
            {
              spent: value.credits.spent + event.cost,
              balanceAfter: event.creditsAfter,
            },
          );
        }),
        entry,
      );
    }

    case "UsageReserved": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "hold",
        holdId: event.holdId,
        feature: event.feature,
        amount: event.amount,
        credits: event.cost,
      };
      return appended(
        withPeriod(timeline, (value) => {
          const feature = value.features[event.feature] ?? emptyFeature;
          return withFeature(value, event.feature, { held: feature.held + event.amount });
        }),
        entry,
      );
    }

    case "UsageSettled": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "settle",
        holdId: event.holdId,
        feature: event.feature,
        amount: event.amount,
        credits: event.cost,
      };
      return appended(
        withPeriod(timeline, (value) => {
          const feature = value.features[event.feature] ?? emptyFeature;
          return withFeature(value, event.feature, {
            settled: feature.settled + event.amount,
            released: feature.released + event.released,
          });
        }),
        entry,
      );
    }

    case "UsageReleased": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "release",
        holdId: event.holdId,
        feature: event.feature,
        amount: event.amount,
        credits: event.cost,
      };
      return appended(
        withPeriod(timeline, (value) => {
          const feature = value.features[event.feature] ?? emptyFeature;
          return withFeature(value, event.feature, { released: feature.released + event.amount });
        }),
        entry,
      );
    }

    case "CreditsGranted": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "credit-grant",
        credits: event.amount,
        creditsAfter: event.balanceAfter,
      };
      return appended(
        withPeriod(timeline, (value) =>
          withCredits(value, {
            granted: value.credits.granted + event.amount,
            balanceAfter: event.balanceAfter,
          }),
        ),
        entry,
      );
    }

    case "CreditsPurchased": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "credit-purchase",
        tier: event.tier,
        credits: event.amount,
        creditsAfter: event.balanceAfter,
        ...(event.price === undefined ? {} : { price: event.price }),
        ...(event.invoiceId === undefined ? {} : { invoiceId: event.invoiceId }),
      };
      return appended(
        withPeriod(timeline, (value) =>
          withCredits(value, {
            purchased: value.credits.purchased + event.amount,
            balanceAfter: event.balanceAfter,
          }),
        ),
        entry,
      );
    }

    case "CreditsConsumed": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "credit-spend",
        credits: event.amount,
        creditsAfter: event.balanceAfter,
      };
      return appended(
        withPeriod(timeline, (value) =>
          withCredits(value, {
            spent: value.credits.spent + event.amount,
            balanceAfter: event.balanceAfter,
          }),
        ),
        entry,
      );
    }

    case "CreditsExpired": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "credit-expire",
        credits: event.amount,
        creditsAfter: event.balanceAfter,
      };
      return appended(
        withPeriod(timeline, (value) =>
          withCredits(value, {
            expired: value.credits.expired + event.amount,
            balanceAfter: event.balanceAfter,
          }),
        ),
        entry,
      );
    }

    case "PaymentRecorded": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "payment",
        charge: event.amount,
        currency: event.currency,
      };
      return appended(timeline, entry);
    }

    case "PaymentFailed": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "payment-failed",
        reason: event.reason,
      };
      return appended(timeline, entry);
    }

    case "ProrationInvoiced": {
      const entry: TimelineEntry = {
        ...stamped(input, periodOf),
        kind: "proration",
        charge: event.amount,
        currency: event.currency,
        invoiceId: event.invoiceId,
      };
      return appended(timeline, entry);
    }

    case "PeriodClosed": {
      const closing = { start: event.periodStart, end: event.periodEnd };
      const entry: TimelineEntry = { ...stamped(input, closing), kind: "period" };
      const closed: UsageTimeline = { ...appended(timeline, entry), open: false };
      return isTerminalStatus(event.statusAfter)
        ? closed
        : {
            ...openPeriod(closed, event.nextPeriodStart, event.nextPeriodEnd),
            lastSeq: envelope.seq,
          };
    }

    // A fact the timeline does not render as an entry: a ref, a cancellation,
    // a scheduled change, a grace transition, a reset. The raw log has them;
    // the timeline is the bill's facts, not every event.
    default:
      return { ...timeline, lastSeq: envelope.seq };
  }
};

/**
 * Fold a log into a timeline. Feed it from the account's first event: the fold
 * derives each entry's period from the activation and close events before it,
 * so a window that starts in the middle has no period to stamp its first
 * entries with.
 *
 * ### A bill's story, from the events a console already holds
 * **Example:** Fold an account's stream entries
 * ```typescript
 * const timeline = timelineOf(entries); // [{ event, envelope }, …]
 * for (const entry of timeline.entries) {
 *   console.log(entry.at, entry.kind, entry.feature ?? "", entry.credits ?? "", entry.charge ?? "");
 * }
 * ```
 *
 * @primitive
 */
export const timelineOf = (inputs: ReadonlyArray<TimelineInput>): UsageTimeline =>
  inputs.reduce(appendTimeline, initialTimeline);
