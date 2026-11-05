import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The deadline asked for is not later than the one in force, so it would not
 * extend the trial. A deadline is the end of the first period — `resetsAt`,
 * the scheduled `PeriodEnded` and the close that opens the next period all
 * read it — so moving it backwards would close a period early and open the
 * next one before the one it replaced. `current` is `now` when the trial has
 * not started yet, and the running trial's deadline when it has.
 */
export class TrialDeadlineNotLater extends Domain.Rejection("TrialDeadlineNotLater", {
  current: Schema.DateTimeUtc,
  requested: Schema.DateTimeUtc,
}) {}
