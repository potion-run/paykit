import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AlreadyCanceled } from "./AlreadyCanceled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The standing will end at the close of the current period. */
export class CancellationScheduled extends Domain.Event("CancellationScheduled", {
  cancelAtPeriodEndAfter: Schema.Boolean,
}) {}

/** Stop at the end of the period. Never stops service immediately. */
export class ScheduleCancellation extends Domain.Command("ScheduleCancellation", {
  target: AccountId,
  events: [CancellationScheduled],
  rejects: [AlreadyCanceled, NotSubscribed],
}) {}
