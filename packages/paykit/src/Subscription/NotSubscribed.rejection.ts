import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** This account has never had a standing, so there is nothing to change. */
export class NotSubscribed extends Domain.Rejection("NotSubscribed", {
  account: Schema.String,
}) {}
