import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The command only applies while the account is in grace. */
export class NotInGrace extends Domain.Rejection("NotInGrace", {
  status: Schema.String,
}) {}
