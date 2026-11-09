import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * An unsafe request came from an origin the deployment did not name. The
 * resolver never ran, so a cross-site page cannot use a signed-in cookie to
 * reach a command even when the browser attaches it (ADR 0033).
 *
 * The refusal names the origin and not the caller: the same answer must not tell
 * a cross-site page whether the session it borrowed was valid.
 */
export class CrossOrigin extends Domain.Rejection("CrossOrigin", {
  /** The `Origin` the request carried, as the browser sent it. */
  origin: Schema.String,
  /** The method, since only an unsafe one is checked. */
  method: Schema.String,
}) {}
