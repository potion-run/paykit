import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The request carries no caller, or carries one the deployment does not
 * accept. Never a reason string: the same refusal must not tell an attacker
 * whether an account exists.
 */
export class Unauthenticated extends Domain.Rejection("Unauthenticated", {
  /** Where the deployment looked for the caller: a header, a cookie, a token. */
  source: Schema.String,
}) {}
