import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The spend would bill past the customer's money ceiling for this feature. Like
 * `SpendCapExceeded` and `MoneyCapExceeded` it is a refusal about quantity, not
 * about standing: the account has used what it allowed itself, and the standing
 * stays `good` (ADR 0038).
 */
export class SpendLimitExceeded extends Domain.Rejection("SpendLimitExceeded", {
  feature: Schema.String,
  /** The customer's ceiling for this feature this period. */
  limit: Schema.Int,
  /** What this feature has already billed this period. */
  billed: Schema.Int,
  /** Money open holds have promised, which counts against the ceiling too. */
  reserved: Schema.optionalKey(Schema.Int),
  /** What this request would bill. */
  charge: Schema.Int,
}) {}
