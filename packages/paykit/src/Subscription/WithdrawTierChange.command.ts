import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** There is no scheduled tier change to withdraw. */
export class NoTierChangeScheduled extends Domain.Rejection("NoTierChangeScheduled") {}

/**
 * The tier change scheduled for the boundary was withdrawn. `tier` is what the
 * account would have moved to: scheduling is replaceable without a record, so
 * the log keeps the one intent that was actually abandoned.
 */
export class TierChangeWithdrawn extends Domain.Event("TierChangeWithdrawn", {
  tier: Schema.String,
}) {}

/**
 * Cancel a tier change scheduled for the period boundary, leaving the standing
 * on the tier it is on.
 *
 * This is the pair of `ScheduleTierChange`, and it sits beside `Resume` for the
 * same reason: both withdraw an intent the standing is carrying. It does not
 * itself move anything — a schedule is data on the standing, so withdrawing it
 * records the abandoned intent and nothing else changes.
 */
export class WithdrawTierChange extends Domain.Command("WithdrawTierChange", {
  target: AccountId,
  input: {},
  events: [TierChangeWithdrawn],
  rejects: [NotSubscribed, NoTierChangeScheduled],
  middleware: [Session],
}) {}
