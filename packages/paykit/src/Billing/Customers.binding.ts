import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import type { BillingControls, Customer } from "../Customer.ts";
import {
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
} from "../Subscription/SetBillingControls.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** The controls a customer is asked to hold. */
export interface CustomerUpdateRequest {
  /** `{}` is the clear; an omitted field is a schema failure, not a wipe. */
  readonly billingControls: BillingControls;
}

const refusals = [
  ControlsFeatureUnknown,
  ControlsFeatureNotPriced,
  ControlsDuplicate,
  CatalogMismatch,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a customer write can answer. */
export type CustomersRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this binding refusing the request. */
export const isCustomersRefusal = oneOf<CustomersRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toCustomersError = toBindingError("Paykit.Customers", isCustomersRefusal);

/** Everything a customer read or write can answer. */
export type CustomersError = BindingError<CustomersRefusal>;

/** A customer, their plans, and the controls they state. */
export interface CustomersVerb {
  /** The customer this binding is bound to. Never returns a refusal for absence. */
  get(): Effect.Effect<Customer, CustomersError>;
  /** Replace the customer's controls and answer the customer they left. */
  update(request: CustomerUpdateRequest): Effect.Effect<Customer, CustomersError>;
}

/**
 * A customer's record: the plans it holds and the controls it states over them.
 * `get` reads the billing view the deployment already folded; `update` writes
 * `SetBillingControls` and reads the view it waited for, so the answer is the
 * state a caller's next read sees.
 *
 * Auto top-up, spend limits and usage alerts live here rather than in the
 * catalog: a support agent can change them without a deploy, and the event log
 * records what was in force when each spend happened (ADR 0038).
 *
 * ### Reading a customer's controls
 * **Example:** Why a spend was refused
 * ```typescript
 * const customers = yield* Paykit.Customers(account);
 * const customer = yield* customers.get();
 * const limit = customer.billingControls.spendLimits?.find((row) => row.featureId === "requests");
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Customers
 */
export interface Customers extends Binding.Service<
  Customers,
  "Paykit.Customers",
  (account: string) => Effect.Effect<CustomersVerb>
> {}

export const Customers = Binding.Service<Customers>("Paykit.Customers");
