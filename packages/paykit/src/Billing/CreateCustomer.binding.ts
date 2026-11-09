import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { CustomerDetails } from "../Customer.ts";
import type { BillingStateView } from "../Subscription/BillingState.view.ts";
import { CustomerExists } from "../Subscription/CustomerExists.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** A name a customer may record: present, non-empty and short enough to render. */
const CustomerName = Schema.optionalKey(
  Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(120))),
);

/**
 * The address a receipt is sent to. The model records it as given and validates
 * nothing else: delivering mail is the deployment's, and a stricter parse would
 * refuse an address a provider accepts.
 */
const CustomerEmail = Schema.optionalKey(
  Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(320))),
);

/** The retry key for a create. Omitted, the identity itself is the key. */
const DedupeKey = Schema.optionalKey(
  Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
);

/** The identity to record. The bound account is not here. */
export const CustomerRequest = Schema.Struct({
  /** The name the account is billed as. */
  name: CustomerName,
  /** The address a receipt or a dunning notice goes to. */
  email: CustomerEmail,
  /**
   * The retry key, when the caller has one. Omitted, the command id is derived
   * from the account and the identity, so the common call needs no extra field
   * and a retry with the same details is the same write.
   */
  dedupeKey: DedupeKey,
});

export type CustomerRequest = typeof CustomerRequest.Type;

/** What the write left in force, and the view it waited for. */
export interface CreateCustomerResult {
  /** The identity in force at the receipt, or absent if the view had not caught up. */
  readonly customer?: CustomerDetails;
  /** The billing view at the receipt, so a caller need not re-read it. */
  readonly view: BillingStateView | null;
}

/**
 * The command id a create derives when the caller states none: the account and
 * the identity, so a retry with the same details replays and a different
 * identity is a different write that `decide` refuses with `CustomerExists`.
 *
 * Each part is percent-encoded, so a `:` or an `@` inside a name or an address
 * cannot spell another identity's key.
 */
export const createCustomerCommandId = (
  account: string,
  request: { readonly name?: string; readonly email?: string },
): string =>
  `create:${encodeURIComponent(account)}:${encodeURIComponent(request.name ?? "")}:${encodeURIComponent(
    request.email ?? "",
  )}`;

const refusals = [CustomerExists, Unauthenticated, Forbidden] as const;

/** Every refusal a customer create can answer. */
export type CreateCustomerRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isCreateCustomerRefusal = oneOf<CreateCustomerRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toCreateCustomerError = toBindingError(
  "Paykit.CreateCustomer",
  isCreateCustomerRefusal,
);

/** Everything this binding can answer. */
export type CreateCustomerError = BindingError<CreateCustomerRefusal>;

/** The verb of a bound `CreateCustomer`. */
export type CreateCustomerVerb = (
  request: CustomerRequest,
) => Effect.Effect<CreateCustomerResult, CreateCustomerError>;

/**
 * Record the identity a billing page shows for this account: its name and its
 * email address. A customer exists as soon as this command records one, so a
 * deployment can create it before it buys anything; no billing decision reads
 * the fields, and a plan change or a close leaves them alone (ADR 0045).
 *
 * A create is idempotent on equal details, whether the retry carries the same
 * command id or derives it again: the second write records nothing and answers
 * the customer the first one left. A create with different details is
 * `CustomerExists` and records nothing — renaming a customer is its own
 * command, and this slice does not invent one. `Paykit.Customers(account)
 * .getOrCreate` is the sign-up path: it answers an existing customer untouched.
 *
 * ### Recording a customer at sign-up
 * **Example:** Before anything is bought
 * ```typescript
 * const createCustomer = yield* Paykit.CreateCustomer(account);
 * const { customer } = yield* createCustomer({ name: "Ada", email: "ada@example.com" });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.CreateCustomer
 */
export interface CreateCustomer extends Binding.Service<
  CreateCustomer,
  "Paykit.CreateCustomer",
  (account: string) => Effect.Effect<CreateCustomerVerb>
> {}

export const CreateCustomer = Binding.Service<CreateCustomer>("Paykit.CreateCustomer");
