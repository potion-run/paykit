import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The caller is authenticated but may not cross the boundary the request
 * names: an account they may not act on, or the operator surface. `scope` says
 * which, so a route can answer "not your account" and "not an operator"
 * differently.
 *
 * An account may act on itself; an admin or the system may act on anything.
 */
export class Forbidden extends Domain.Rejection("Forbidden", {
  /** The account the caller tried to reach. */
  account: Schema.String,
  /** The caller's own id. */
  actor: Schema.String,
  /** The caller's kind: `account`, `admin` or `system`. */
  kind: Schema.Literals(["account", "admin", "system"]),
  /**
   * The boundary the caller crossed: `account` for a target they may not act
   * on, `admin` for the operator surface. Absent on a rejection written before
   * the field existed, so old state and old tests still decode.
   */
  scope: Schema.optionalKey(Schema.Literals(["account", "admin"])),
}) {}
