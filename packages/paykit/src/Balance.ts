import * as Schema from "effect/Schema";

/** Where one part of a balance came from. */
export const BalanceSourceKind = Schema.Literals(["plan", "addon", "one_off", "rollover", "grant"]);

export type BalanceSourceKind = typeof BalanceSourceKind.Type;

/** One source of a feature balance. */
export const BalanceSource = Schema.Struct({
  id: Schema.String,
  kind: BalanceSourceKind,
  granted: Schema.Int,
  remaining: Schema.Int,
  usage: Schema.Int,
  interval: Schema.String,
  planId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  resetAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type BalanceSource = typeof BalanceSource.Type;

/** What a customer can spend of one feature, and where it came from. */
export const Balance = Schema.Struct({
  featureId: Schema.String,
  granted: Schema.Int,
  remaining: Schema.Int,
  usage: Schema.Int,
  unlimited: Schema.Boolean,
  overageAllowed: Schema.Boolean,
  nextResetAt: Schema.NullOr(Schema.DateTimeUtc),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  breakdown: Schema.Array(BalanceSource),
});

export type Balance = typeof Balance.Type;

/** A list of balances, with the cursor a page reads next. */
export const BalancePage = Schema.Struct({
  balances: Schema.Array(Balance),
  cursor: Schema.NullOr(Schema.String),
});

export type BalancePage = typeof BalancePage.Type;
