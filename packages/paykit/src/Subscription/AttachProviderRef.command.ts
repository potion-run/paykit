import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PendingActivation } from "./PendingActivation.ts";
import { AccountId } from "./Subscription.id.ts";
import { ProviderRefs } from "./Subscription.state.ts";

/**
 * A vendor id was stored, keyed by provider. Nothing else in the model reads it
 * for money; the pending terms are the exception, because a hosted purchase
 * names the plan and not what was quoted for it (ADR 0042 §1).
 */
export class ProviderRefAttached extends Domain.Event("ProviderRefAttached", {
  provider: Schema.String,
  refs: ProviderRefs,
  /** The terms the checkout quoted, when it quoted any. */
  pending: Schema.optionalKey(PendingActivation),
}) {}

/**
 * Attach vendor identifiers for an account. A provider adapter calls this
 * after checkout; `decide` never reads the result. The pending terms travel on
 * the command and into the event, so the webhook that completes the purchase
 * activates what was sold rather than what the catalog states now.
 */
export class AttachProviderRef extends Domain.Command("AttachProviderRef", {
  target: AccountId,
  input: {
    provider: Schema.String,
    refs: ProviderRefs,
    /** The terms this purchase quoted, when the purchase is an activation. */
    pending: Schema.optionalKey(PendingActivation),
  },
  events: [ProviderRefAttached],
  rejects: [],
}) {}
