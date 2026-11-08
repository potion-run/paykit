import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { type PaymentError, PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import { AlreadySubscribed } from "../Subscription/AlreadySubscribed.rejection.ts";
import { TierNotInCatalog } from "../Subscription/TierNotInCatalog.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";
import type { SubscribeResult } from "./Subscribe.operation.ts";

/**
 * Buy a tier. There is no `dedupeKey`: the purchase path is not a command but a
 * provider reference, and that reference is the identity of the thing being
 * bought — a retry re-derives the same checkout or invoice rather than a second
 * one.
 */
export interface SubscribeRequest {
  /** The tier to buy. Its price decides whether there is anything to pay. */
  readonly tier: string;
  /** The account's period anchor. Defaults to UTC. */
  readonly anchorTz?: string;
  /** The currency to sell in. Omitted means the tier's base currency. */
  readonly currency?: string;
}

const refusals = [
  AlreadySubscribed,
  TierNotInCatalog,
  PaymentDeclined,
  ProviderCapabilityMissing,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this operation can answer before the provider is asked. */
export type SubscribeRefusal = InstanceType<(typeof refusals)[number]>;

export type SubscribeError = BindingError<SubscribeRefusal | PaymentError>;

/** Whether a failure is the model refusing the purchase. */
export const isSubscribeRefusal = oneOf<SubscribeRefusal>(refusals);

/**
 * A layer's own failure, as this binding's declared union. Provider failures
 * (`PaymentDeclined`, `ProviderCapabilityMissing`) pass through undecorated: a
 * caller has to tell "no card" from "no transport".
 */
export const toSubscribeError = toBindingError("Paykit.Subscribe", isSubscribeRefusal);

/** The verb of a bound `Subscribe`. */
export type SubscribeVerb = (
  request: SubscribeRequest,
) => Effect.Effect<SubscribeResult, SubscribeError>;

/**
 * The one door to a purchase. A free tier activates immediately and waits for
 * the `Entitlements` view, so a `Check` straight after sees it. A priced tier
 * opens the provider's purchase path — a hosted checkout when it has one, a
 * send-invoice when it only has that — and activates when the provider's
 * `payment_succeeded` or `checkout_completed` webhook arrives.
 *
 * An operation, not a command: the Api serves the command, but the purchase path
 * is the provider's, and only the deployment that holds the provider can walk
 * it.
 *
 * ### Selling a tier
 * **Example:** Free activates; priced redirects
 * ```typescript
 * const subscribe = yield* Paykit.Subscribe(account);
 * const purchase = yield* subscribe({ tier: "pro" });
 * if ("url" in purchase) return Response.redirect(purchase.url);
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Subscribe
 */
export interface Subscribe extends Binding.Service<
  Subscribe,
  "Paykit.Subscribe",
  (account: string) => Effect.Effect<SubscribeVerb>
> {}

export const Subscribe = Binding.Service<Subscribe>("Paykit.Subscribe");
