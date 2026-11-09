import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import type { BillingControls, Customer } from "../Customer.ts";
import { CustomerExists } from "../Subscription/CustomerExists.rejection.ts";
import {
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
} from "../Subscription/SetBillingControls.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";
import type { CustomerRequest } from "./CreateCustomer.binding.ts";

/** The controls a customer is asked to hold. */
export interface CustomerUpdateRequest {
  /** `{}` is the clear; an omitted field is a schema failure, not a wipe. */
  readonly billingControls: BillingControls;
}

const refusals = [
  CustomerExists,
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
  /**
   * Record the customer's identity: its name and its email. A retry with the
   * same details records nothing; a different identity is `CustomerExists`.
   */
  create(request: CustomerRequest): Effect.Effect<Customer, CustomersError>;
  /**
   * The customer as it stands, created with these details when it has none.
   * This is the idempotent sign-up path: an existing customer is answered
   * untouched and never refused.
   */
  getOrCreate(request: CustomerRequest): Effect.Effect<Customer, CustomersError>;
  /** Replace the customer's controls and answer the customer they left. */
  update(request: CustomerUpdateRequest): Effect.Effect<Customer, CustomersError>;
}

/**
 * A customer's record: the identity it recorded, the plans it holds and the
 * controls it states over them. `get` reads the billing view the deployment
 * already folded; `create` and `update` write a command and answer the customer
 * the write waited for, so the answer is the state a caller's next read sees.
 *
 * `create` states the identity once and `getOrCreate` is the idempotent
 * sign-up path: a read first, and the same create only when the record is
 * absent (ADR 0045). Auto top-up, spend limits and usage alerts live here
 * rather than in the catalog: a support agent can change them without a deploy,
 * and the event log records what was in force when each spend happened
 * (ADR 0038).
 *
 * ### Reading a customer's controls
 * **Example:** Why a spend was refused
 * ```typescript
 * const customers = yield* Paykit.Customers(account);
 * const customer = yield* customers.get();
 * const limit = customer.billingControls.spendLimits?.find((row) => row.featureId === "requests");
 * ```
 *
 * ### Recording a customer, then a retry that records nothing
 * **Example:** A sign-up that is safe to repeat
 * ```typescript
 * const customers = yield* Paykit.Customers(account);
 * const customer = yield* customers.getOrCreate({ name: "Ada", email: "ada@example.com" });
 * const again = yield* customers.getOrCreate({ name: "Ada", email: "ada@example.com" });
 * // customer.createdAt === again.createdAt; one CustomerCreated in the log
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
