import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The caller is authenticated but may not act on the account the command or
 * read targets. An account may act on itself; an admin or the system may act
 * on anything.
 */
export class Forbidden extends Domain.Rejection("Forbidden", {
  /** The account the caller tried to reach. */
  account: Schema.String,
  /** The caller's own id. */
  actor: Schema.String,
  /** The caller's kind: `account`, `admin` or `system`. */
  kind: Schema.Literals(["account", "admin", "system"]),
}) {}
