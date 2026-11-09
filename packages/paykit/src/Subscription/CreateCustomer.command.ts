import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CustomerExists } from "./CustomerExists.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The identity the account recorded about itself. It is additive and it is a
 * latch: the first create writes it, and no later event moves it (ADR 0045).
 */
export class CustomerCreated extends Domain.Event("CustomerCreated", {
  /** The name the account is billed as. */
  name: Schema.optionalKey(Schema.String),
  /** The address a receipt or a dunning notice goes to. */
  email: Schema.optionalKey(Schema.String),
  /** When the identity was recorded. */
  at: Schema.DateTimeUtc,
}) {}

/**
 * Record the customer's identity: the name and email a billing page shows. A
 * customer exists as soon as this command records one, so a deployment can
 * create it before it buys anything, and no billing decision reads the fields
 * (ADR 0045).
 *
 * The account is the customer, as everywhere else: this is a command on the
 * account's aggregate and the identity is customer state, not plan state. A
 * create with the details already in force records nothing, so a retry is a
 * replay; a create with different details is `CustomerExists`, because renaming
 * a customer is a separate concern and not in this slice.
 *
 * ### Recording a customer at sign-up
 * **Example:** A customer that has not bought yet
 * ```typescript
 * const customers = yield* Paykit.Customers(account);
 * const customer = yield* customers.create({ name: "Ada", email: "ada@example.com" });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.CreateCustomer
 */
export class CreateCustomer extends Domain.Command("CreateCustomer", {
  target: AccountId,
  input: {
    name: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
  },
  events: [CustomerCreated],
  rejects: [CustomerExists, Forbidden, Unauthenticated],
  middleware: [Session],
}) {}
