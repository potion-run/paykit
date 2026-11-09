import * as Schema from "effect/Schema";

/**
 * A plan operation that needs a capability the current slice does not have. It
 * is a refusal about the *operation*, not about the plan: the plan is sold, the
 * caller is allowed to ask, and the composition the operation needs has not
 * landed yet.
 *
 * A bespoke deal across a hosted checkout is no longer here: the quoted terms
 * ride the provider reference and the completion activates them (ADR 0042 §1).
 */
export class PlanOperationUnsupported extends Schema.TaggedError<PlanOperationUnsupported>()(
  "PlanOperationUnsupported",
  {
    planId: Schema.String,
    reason: Schema.Literals([
      "quantities_on_scheduled_change",
      "quantities_on_checkout",
      "cancel_immediately",
      "nothing_to_uncancel",
      "no_change",
      "refund_charge_unknown",
    ]),
  },
) {}
