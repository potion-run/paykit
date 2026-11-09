import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * This account already recorded a different identity. A create states the
 * identity once: a retry with the same name and email records nothing, and a
 * changed one is this refusal, because renaming a customer is its own command
 * and is not in this slice (ADR 0045).
 *
 * The fields are the details already in force, so an operator can reconcile
 * the two identities instead of guessing which one the account holds.
 */
export class CustomerExists extends Domain.Rejection("CustomerExists", {
  account: Schema.String,
  name: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
}) {}
