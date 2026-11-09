import * as Schema from "effect/Schema";

/**
 * A plan operation that needs a capability the current slice does not have. It
 * is a refusal about the *operation*, not about the plan: the plan is sold, the
 * caller is allowed to ask, and the composition the operation needs has not
 * landed yet.
 *
 * `custom_plan_checkout` is the custom-plan case (ADR 0041 §7): a bespoke
 * allowance set travels on the command, and a hosted checkout's activation is
 * rebuilt from the catalog when the provider's webhook lands, so the negotiated
 * items would be replaced by the plan's defaults. The deal is still sold as an
 * immediate move or a scheduled phase, which never cross a checkout.
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
      "custom_plan_checkout",
      "multi_plan_on_inactive",
      "multi_plan_quantity",
      "not_an_add_on",
    ]),
  },
) {}
