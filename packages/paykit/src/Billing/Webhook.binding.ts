import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import {
  PendingActivationAmbiguous,
  PendingActivationMissing,
  PendingActivationStale,
} from "../Subscription/PendingActivation.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { WebhookInvalid } from "../Webhooks.ts";
import type { WebhookAction, WebhookEvent } from "../Webhooks.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

const refusals = [
  WebhookInvalid,
  PlanNotInCatalog,
  PendingActivationMissing,
  PendingActivationStale,
  PendingActivationAmbiguous,
] as const;

/**
 * Every refusal applying a delivery can answer. They are the *edge's* own
 * judgement — a payload that names no tier, a tier the deploy does not sell, or
 * a completion whose quoted terms are missing or belong to another purchase. A
 * model rejection that reaches here becomes `BindingFailed` on purpose: a
 * delivery paykit could not apply is one the provider should retry, and "we do
 * not know" is the honest answer to retry on. A quote that is gone is different:
 * retrying it would find the same nothing, so it is a refusal the edge answers.
 * A delivery that names no quote while the account holds several is the same
 * kind of refusal: the edge cannot tell which purchase it completes.
 */
export type WebhookRefusal = InstanceType<(typeof refusals)[number]>;

export type WebhookApplyError = BindingError<WebhookRefusal>;

/** Whether a failure is the edge refusing a delivery it cannot apply. */
export const isWebhookRefusal = oneOf<WebhookRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toWebhookError = toBindingError("Paykit.Webhook", isWebhookRefusal);

/** The verb of a bound `Webhook`. Deployment-scoped, so it takes no account. */
export type WebhookVerb = (event: WebhookEvent) => Effect.Effect<WebhookAction, WebhookApplyError>;

/**
 * The webhook edge as a binding: the model's services resolved once, an event
 * applied per delivery. The provider's event id is the command id, so a
 * redelivery is a replay rather than a second charge, and a one-off pack
 * purchase adds credits instead of creating a standing.
 *
 * The bind takes nothing — the deployment is the scope — and the request is the
 * *decoded* event. This is the one binding that does **not** wait for a read
 * model afterwards: it has no receipt of its own to wait on, and a provider
 * needs an answer, not a snapshot. Whoever reads next reads the view.
 *
 * The bind takes nothing, so a delivery for any account can be applied. Decoding is the provider's: `Stripe()` and `Polar()` return a
 * `webhook.decode` that verifies the signature and translates the payload, and a
 * `none` from it is a 202 that records nothing.
 *
 * ### Applying a delivery
 * **Example:** Verify, then apply
 * ```typescript
 * const webhook = yield* Paykit.Webhook();
 *
 * const decoded = yield* provider.webhook.decode(request);
 * if (Option.isNone(decoded)) return new Response(null, { status: 202 });
 * const action = yield* webhook(decoded.value);
 * return Response.json({ action }, { status: 202 });
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.Webhook
 */
export interface Webhook extends Binding.Service<
  Webhook,
  "Paykit.Webhook",
  () => Effect.Effect<WebhookVerb>
> {}

export const Webhook = Binding.Service<Webhook>("Paykit.Webhook");
