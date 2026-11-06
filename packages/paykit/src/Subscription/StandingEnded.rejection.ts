import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The standing has ended. A command that would move its money or its tier has
 * nothing left to move: an expired or canceled account can only be replaced by
 * a new activation. Goodwill grants, purchases, refunds and provider refs stay
 * outside this guard because they do not depend on an open period.
 */
export class StandingEnded extends Domain.Rejection("StandingEnded", {
  account: Schema.String,
  /** The terminal status: `expired` or `canceled`. */
  status: Schema.String,
}) {}
