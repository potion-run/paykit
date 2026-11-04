import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The scheduled cancellation was withdrawn. */
export class CancellationWithdrawn extends Domain.Event("CancellationWithdrawn", {
  cancelAtPeriodEndAfter: Schema.Boolean,
}) {}

/** Undo a scheduled cancellation. */
export class Resume extends Domain.Command("Resume", {
  target: AccountId,
  events: [CancellationWithdrawn],
  rejects: [NotScheduled, NotSubscribed],
  middleware: [Session],
}) {}
