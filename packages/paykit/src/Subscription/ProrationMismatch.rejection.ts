import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Proration } from "../Proration.ts";

/**
 * The proration a tier change carried is not the one its prices and period
 * work out to. The event records the money that moved, so a number nobody
 * computed from the model is a number nobody can audit.
 */
export class ProrationMismatch extends Domain.Rejection("ProrationMismatch", {
  /** What `prorate()` works out from the account's prices and period. */
  expected: Schema.NullOr(Proration),
  /** What the command carried. */
  actual: Schema.NullOr(Proration),
}) {}
