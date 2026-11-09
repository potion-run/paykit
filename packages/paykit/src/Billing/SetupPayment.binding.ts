import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** What a setup page answers: a hosted URL. */
export interface SetupPaymentResult {
  readonly url: string;
}

const setupRefusals = [
  ProviderCapabilityMissing,
  PaymentDeclined,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal adding a payment method can answer. */
export type SetupPaymentRefusal = InstanceType<(typeof setupRefusals)[number]>;

export type SetupPaymentError = BindingError<SetupPaymentRefusal>;

/** Whether a failure is the provider refusing to open a setup page. */
export const isSetupPaymentRefusal = oneOf<SetupPaymentRefusal>(setupRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toSetupPaymentError = toBindingError("Paykit.SetupPayment", isSetupPaymentRefusal);

/** The verb of a bound `SetupPayment`. The account is the bind, so it takes nothing. */
export type SetupPaymentVerb = () => Effect.Effect<SetupPaymentResult, SetupPaymentError>;

/**
 * Add a payment method without a purchase. The provider hosts the page and the
 * deployment redirects there: a free plan that wants a card on file, a trial
 * that asks for one up front, or a dunning recovery that replaces an expired
 * card. It never charges, never opens a period and writes no paykit command —
 * the URL is the whole answer, exactly like `Portal`.
 *
 * The page belongs to the provider the account already pays through, so the
 * standing picks it and only that provider's layer is provided for the call. A
 * provider with no hosted method page is `ProviderCapabilityMissing`, never a
 * fake URL.
 *
 * ### Adding a card before an upgrade
 * **Example:** Send a customer to the provider's setup page
 * ```typescript
 * const setupPayment = yield* Paykit.SetupPayment(account);
 * const { url } = yield* setupPayment();
 * return Response.redirect(url);
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.SetupPayment
 */
export interface SetupPayment extends Binding.Service<
  SetupPayment,
  "Paykit.SetupPayment",
  (account: string) => Effect.Effect<SetupPaymentVerb>
> {}

export const SetupPayment = Binding.Service<SetupPayment>("Paykit.SetupPayment");
