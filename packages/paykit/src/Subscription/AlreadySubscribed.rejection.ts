import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The account already has an open standing. A second `Subscribe` would reset
 * the period, the counters and the holds, so it is refused; a terminal
 * standing is the one case a new activation may replace.
 */
export class AlreadySubscribed extends Domain.Rejection("AlreadySubscribed", {
  account: Schema.String,
  /** The status the standing is already in. */
  status: Schema.String,
}) {}
