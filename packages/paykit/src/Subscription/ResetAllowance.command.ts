import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { UsageReleased } from "./ReleaseHold.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * One allowance's window closed and a new one opened. The event carries the
 * outcome — what the feature has left, how much of it rolled over, and the next
 * boundary — so a replay reproduces the window without reading the catalog.
 */
export class PlanItemReset extends Domain.Event("PlanItemReset", {
  feature: Schema.String,
  /** Spendable after the reset; `null` for an allowance with no count. */
  remaining: Schema.NullOr(Schema.Int),
  /** The units that rolled into the new window. */
  carried: Schema.Int,
  /** The next boundary, or `null` when the allowance never resets again. */
  resetAt: Schema.NullOr(Schema.DateTimeUtc),
}) {}

/**
 * Close one allowance's window when its own schedule says so. A scheduled
 * caller fires only after the boundary; before it, or on a feature that has no
 * independent schedule, the command records nothing.
 *
 * A monthly or annual allowance follows the standing's period and is reset by
 * `ClosePeriod`; this command is for the schedules the period does not own.
 */
export class ResetAllowance extends Domain.Command("ResetAllowance", {
  target: AccountId,
  input: {
    feature: Schema.String,
    /** The boundary the caller believes it is resetting. */
    at: Schema.DateTimeUtc,
  },
  events: [UsageReleased, PlanItemReset],
  rejects: [],
}) {}
