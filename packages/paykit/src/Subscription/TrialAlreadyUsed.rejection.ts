import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The account already has a trial on record. */
export class TrialAlreadyUsed extends Domain.Rejection("TrialAlreadyUsed", {
  account: Schema.String,
}) {}
