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

/** An absolute timestamp, in the operator's locale. */
export const formatDateTime = (value: DateTime.Utc): string =>
  DateTime.toDate(value).toLocaleString("en", {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const formatOptionalDateTime = (value: DateTime.Utc | undefined): string =>
  value === undefined ? "—" : formatDateTime(value);
