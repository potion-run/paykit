import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { Price } from "./Tier.ts";

/** One billable period, independent of the subscription state that owns it. */
export const ProrationPeriod = Schema.Struct({
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
});
export type ProrationPeriod = typeof ProrationPeriod.Type;

/** What a mid-cycle tier change costs. Every amount is a minor unit. */
export const Proration = Schema.Struct({
  currency: Schema.String,
  credit: Schema.Int,
  charge: Schema.Int,
  /** `charge - credit`: negative means the account is owed. */
  due: Schema.Int,
});
export type Proration = typeof Proration.Type;

/** The unused part of a period, as a fraction in `[0, 1]`. */
export const unusedFraction = (period: ProrationPeriod, at: DateTime.Utc): number => {
  const start = DateTime.toEpochMillis(period.start);
  const end = DateTime.toEpochMillis(period.end);
  const now = DateTime.toEpochMillis(at);
  if (end <= start) return 0;
  const fraction = (end - now) / (end - start);
  return Math.min(1, Math.max(0, fraction));
};

/** Round a price by a fraction, with every unit accounted for. */
const portion = (amount: number, fraction: number): number =>
  Math.min(amount, Math.max(0, Math.round(amount * fraction)));

/**
 * Prorate a tier change. The credit is the unused share of the old price; the
 * charge is the unused share of the new price. When both prices are equal the
 * two cancel exactly, so a no-op change costs nothing.
 */
export const prorate = (input: {
  readonly from: Price | undefined;
  readonly to: Price | undefined;
  readonly period: ProrationPeriod;
  readonly at: DateTime.Utc;
}): Proration | null => {
  const { from, to } = input;
  if (from === undefined && to === undefined) return null;
  if (from !== undefined && to !== undefined && from.currency !== to.currency) return null;
  const currency = from?.currency ?? to!.currency;
  if (from !== undefined && to !== undefined && from.interval !== to.interval) {
    // A cadence change is not a mid-cycle proration: the next period owns it.
    return null;
  }
  const fraction = unusedFraction(input.period, input.at);
  const credit = from === undefined ? 0 : portion(from.amount, fraction);
  const charge = to === undefined ? 0 : portion(to.amount, fraction);
  return { currency, credit, charge, due: charge - credit };
};
