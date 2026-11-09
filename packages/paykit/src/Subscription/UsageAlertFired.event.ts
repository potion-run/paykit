import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A customer's usage reached one of its alert thresholds. It is evidence only:
 * it moves no counter, refuses nothing, and a replay records it once because
 * the standing latches the `(feature, threshold)` pair for the period
 * (ADR 0038).
 */
export class UsageAlertFired extends Domain.Event("UsageAlertFired", {
  feature: Schema.String,
  /** The control's threshold, in the feature's period usage units. */
  at: Schema.Int,
  /** The feature's period usage after the event that fired it. */
  usedAfter: Schema.Int,
  /** The recording event's own time, so a page can say when. */
  firedAt: Schema.DateTimeUtc,
}) {}
