import * as Stripe from "@alchemy.run/stripe";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The event types `Webhooks.ts` decodes. A Stripe event outside this list is
 * not a standing change, so the deploy does not ask the endpoint to deliver it:
 * every delivery would be verified and then dropped.
 */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.deleted",
] as const;

/** Where a deployment serves the Stripe delivery route. */
export const DEFAULT_WEBHOOK_PATH = "/webhooks/stripe";

/** The URL a deployment asks Stripe to deliver to: the app's origin plus the route. */
export const stripeWebhookUrl = (origin: string, path?: string): string =>
  `${origin}${path ?? DEFAULT_WEBHOOK_PATH}`;

/**
 * An endpoint that answered without a signing secret leaves the deployment with
 * no verifier for the deliveries Stripe sends to it.
 *
 * Stripe returns the secret only when the endpoint is created, and Alchemy keeps
 * it in state for later reconciles, so a missing one means the endpoint was
 * adopted from outside this stack. The failure is raised where the secret is
 * read — the Worker's environment, or a delivery being verified — because the
 * stack program has no value to check: a Worker that starts with no verifier
 * accepts nothing and refuses everything.
 */
export class StripeWebhookSecretMissing extends Schema.TaggedError<StripeWebhookSecretMissing>()(
  "StripeWebhookSecretMissing",
  {
    /** The Stripe endpoint id that answered without a secret. */
    endpoint: Schema.String,
  },
) {}

/**
 * The webhook endpoint a deployment serves Stripe's deliveries on.
 *
 * `StripeBilling` creates it when the deploy has no `webhookSecret`: the URL is
 * the app's origin plus `/webhooks/stripe`, the events are exactly the ones
 * `stripeWebhook` decodes, and the secret Stripe mints at create is what the
 * Worker verifies with. Supplying `webhookSecret` keeps the endpoint
 * hand-managed and creates nothing here.
 *
 * The vendor object is `@alchemy.run/stripe`'s own `WebhookEndpoint`, so the
 * ownership metadata, adoption and drift are that package's job, not a second
 * implementation's. Removal is the default `destroy`: an endpoint is
 * configuration, not financial history, and a stack destroy has already removed
 * the Worker that would answer its deliveries.
 *
 * ### Receiving Stripe's events
 * **Example:** The endpoint beside the prices
 * ```typescript
 * const endpoint = yield* stripeWebhookEndpoint("Deliveries", {
 *   url: "https://app.example.com/webhooks/stripe",
 * });
 * // The Worker verifies deliveries with the secret minted at create; the
 * // billing result carries it into the environment as an Output.
 * ```
 *
 * @primitive
 * @product Stripe
 */
export const stripeWebhookEndpoint = Effect.fn("Stripe.webhookEndpoint")(function* (
  id: string,
  props: { readonly url: Input<string>; readonly events?: ReadonlyArray<string> },
) {
  return yield* Stripe.WebhookEndpoint(id, {
    url: props.url,
    enabledEvents: [...(props.events ?? STRIPE_WEBHOOK_EVENTS)],
    description: "paykit billing",
  });
});
