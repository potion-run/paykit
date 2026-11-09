import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { AlreadyCanceled } from "./AlreadyCanceled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PlanRow as PlanRowSchema } from "./PlanSet.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * Cancelling the default plan of a group is refused: the fallback would be the
 * plan being cancelled, so the operation would record an intent with no effect
 * (ADR 0039 §5).
 */
export class DefaultPlanNotCancelable extends Domain.Rejection("DefaultPlanNotCancelable", {
  /** The group whose default was named. */
  group: Schema.String,
  /** The default plan the cancellation would have replaced with itself. */
  planId: Schema.String,
}) {}

/** A cancellation named a group that holds no plan. */
export class PlanGroupEmpty extends Domain.Rejection("PlanGroupEmpty", {
  group: Schema.String,
}) {}

export {
  PlanCancellation,
  PlanCancellations,
  PlanCancellationRequest,
} from "./PlanCancellation.ts";

export { GroupCancellationWithdrawn, UncancelGroup } from "./UncancelGroup.command.ts";

/** A group will fall back to its default plan, or be left empty, at the boundary. */
export class GroupCancellationScheduled extends Domain.Event("GroupCancellationScheduled", {
  /** The group whose plan is cancelled. */
  group: Schema.String,
  /** The plan the group holds now. */
  planId: Schema.String,
  /**
   * The terms the boundary falls back to, frozen when the cancellation was
   * scheduled so the close needs no catalog. Absent means the group empties.
   */
  fallback: Schema.optionalKey(PlanRowSchema),
}) {}

/** A cancelled group was left with no plan at its boundary. */
export class PlanGroupCanceled extends Domain.Event("PlanGroupCanceled", {
  group: Schema.String,
  planId: Schema.String,
}) {}

/**
 * Cancel one group's plan at its boundary. The group resolves to its `isDefault`
 * plan when it states one and is left empty when it does not; the add-ons and
 * every other group are untouched (ADR 0039 §5).
 */
export class CancelGroup extends Domain.Command("CancelGroup", {
  target: AccountId,
  input: {
    /** The group to cancel; absent means the default group. */
    group: Schema.optionalKey(Schema.String),
    /**
     * The group's default plan and the terms it needs at the boundary. The
     * binding resolves it from the catalog; absent means the group states none.
     */
    fallback: Schema.optionalKey(PlanRowSchema),
  },
  events: [GroupCancellationScheduled],
  rejects: [
    NotSubscribed,
    StandingEnded,
    AlreadyCanceled,
    DefaultPlanNotCancelable,
    PlanGroupEmpty,
  ],
  middleware: [Session],
}) {}
