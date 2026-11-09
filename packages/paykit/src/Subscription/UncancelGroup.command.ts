import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** A group's pending cancellation was withdrawn. */
export class GroupCancellationWithdrawn extends Domain.Event("GroupCancellationWithdrawn", {
  group: Schema.String,
}) {}

/** Clear one group's pending cancellation. Phases the cancellation dropped stay dropped. */
export class UncancelGroup extends Domain.Command("UncancelGroup", {
  target: AccountId,
  input: {
    /** The group to resume; absent means the default group. */
    group: Schema.optionalKey(Schema.String),
  },
  events: [GroupCancellationWithdrawn],
  rejects: [NotSubscribed, StandingEnded, NotScheduled],
  middleware: [Session],
}) {}
