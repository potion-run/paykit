import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The account already pays in one currency and the new price is in another. */
export class CurrencyMismatch extends Domain.Rejection("CurrencyMismatch", {
  expected: Schema.String,
  actual: Schema.String,
}) {}
