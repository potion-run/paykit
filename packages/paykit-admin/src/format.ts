import * as DateTime from "effect/DateTime";

const currencyFormatter = (currency: string): Intl.NumberFormat | null => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency });
  } catch {
    return null;
  }
};

const fractionDigits = (currency: string): number =>
  currencyFormatter(currency)?.resolvedOptions().maximumFractionDigits ?? 2;

/** Format integer minor units without ever turning money into a float in the model. */
export const formatMoney = (amount: number, currency: string | undefined): string => {
  if (currency === undefined) return `${amount} minor units`;
  const digits = fractionDigits(currency);
  const formatter = currencyFormatter(currency);

  return formatter === null
    ? `${amount} ${currency.toUpperCase()} minor units`
    : formatter.format(amount / 10 ** digits);
};

/**
 * A count with its unit, localized. Credits, messages and seats are counts,
 * never money: a pool of 4,820 credits is not $48.20.
 */
export const formatCount = (value: number, unit: string): string =>
  `${value.toLocaleString("en")} ${unit}`;

/** A credit balance, with the unit spoken: "4,820 credits". */
export const formatCredits = (value: number): string =>
  formatCount(value, value === 1 ? "credit" : "credits");

/** A billing date without a time, which is the unit an operator says out loud. */
export const formatDate = (value: DateTime.Utc): string =>
  DateTime.toDate(value).toLocaleDateString("en", { dateStyle: "medium" });

export const formatOptionalDate = (value: DateTime.Utc | undefined): string =>
  value === undefined ? "—" : formatDate(value);

/** An absolute timestamp, in the operator's locale. */
export const formatDateTime = (value: DateTime.Utc): string =>
  DateTime.toDate(value).toLocaleString("en", {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const formatOptionalDateTime = (value: DateTime.Utc | undefined): string =>
  value === undefined ? "—" : formatDateTime(value);
