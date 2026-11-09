import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CustomerId, EntityId } from "../Customer.ts";
import type { Customer, CustomerPlan } from "../Customer.ts";
import { PlanId } from "../Plan.ts";
import type { BillingStateView } from "../Subscription/BillingState.view.ts";
import { mapBindingFailure } from "./Bindings.ts";
import { CreateCustomer, type CustomerRequest } from "./CreateCustomer.binding.ts";
import { Customers, type CustomersError, toCustomersError } from "./Customers.binding.ts";
import { SetBillingControls } from "./SetBillingControls.binding.ts";

/**
 * The read a `Customers` verb answers from: one account's billing view. It is a
 * service so the in-process layer and the Api layer compose the same binding
 * instead of writing the customer twice.
 *
 * @primitive
 */
export class CustomersRead extends Context.Service<
  CustomersRead,
  {
    readonly view: (account: string) => Effect.Effect<BillingStateView | null, CustomersError>;
  }
>()("paykit/CustomersRead") {}

/**
 * The `Customer` a view describes. A customer exists before it buys: an id with
 * no plan is a customer with no plans, not a refusal.
 */
const customerOf = (account: string, view: BillingStateView | null): Customer => {
  // A customer holds a plan set, not one tier: every active row is a plan, and
  // the phase that replaces its group is its scheduled change.
  const rows = Object.values(view?.plans ?? {});
  const scheduled = new Map<string, string>();

  for (const phase of view?.schedule ?? []) scheduled.set(phase.group, phase.planId);

  const plans: Array<CustomerPlan> = rows.map((row) => {
    const next = scheduled.get(row.group);

    return {
      planId: PlanId.make(row.planId),
      status: view!.status,
      ...(row.addOn || next === undefined || next === row.planId
        ? {}
        : { scheduledPlanId: PlanId.make(next) }),
    };
  });

  return {
    id: CustomerId.make(account),
    ...(view?.customer?.name === undefined ? {} : { name: view.customer.name }),
    ...(view?.customer?.email === undefined ? {} : { email: view.customer.email }),
    ...(view?.customer?.createdAt === undefined ? {} : { createdAt: view.customer.createdAt }),
    plans,
    ...(view?.billingControls === undefined ? {} : { billingControls: view.billingControls }),
    // The entity list is the same read `Paykit.Entities(account).list()` serves;
    // the scope's plans and balances stay on its `Balance` (ADR 0040 §4).
    entities: (view?.entities ?? []).map((entity) => ({
      id: EntityId.make(entity.id),
      parentId: CustomerId.make(account),
      ...(entity.name === undefined ? {} : { name: entity.name }),
      status: entity.status,
      createdAt: entity.createdAt,
      ...(entity.archivedAt === undefined ? {} : { archivedAt: entity.archivedAt }),
    })),
  };
};

/**
 * The customer surface: the record a billing page shows and the writes a caller
 * makes over it. It adds no state of its own: `get` reads the billing view, and
 * every write sends its command and reads the view it waited for, so a caller
 * cannot see a customer the model has not recorded.
 *
 * `create` records the identity and `getOrCreate` is the idempotent sign-up
 * path — a read, and the same create only when the record is absent — so the
 * two verbs keep distinct meanings (ADR 0045).
 *
 * ### Changing a customer's ceiling
 * **Example:** Cap and alert in one call
 * ```typescript
 * const customers = yield* Paykit.Customers(account);
 * yield* customers.update({
 *   billingControls: {
 *     spendLimits: [{ featureId: "requests", amount: 10_000 }],
 *     usageAlerts: [{ featureId: "requests", at: 8_000 }],
 *   },
 * });
 * ```
 *
 * @layer
 * @product Subscription
 * @provides Paykit.Customers
 */
export const CustomersLive = Layer.effect(
  Customers,
  Effect.gen(function* () {
    const read = yield* CustomersRead;
    const setControls = yield* SetBillingControls;
    const createCustomer = yield* CreateCustomer;

    const viewOf = (account: string) =>
      mapBindingFailure<CustomersError>(toCustomersError)(read.view(account));

    // The create answers the view it waited for. Reading again would race the
    // projection and could report the customer before this write.
    const created = (account: string, request: CustomerRequest) =>
      Effect.gen(function* () {
        const create = yield* createCustomer(account);
        const result = yield* create(request);

        return customerOf(account, result.view);
      });

    return Effect.fn("Paykit.Customers")(function* (account) {
      return {
        get: Effect.fn("Paykit.Customers.get")(function* () {
          const view = yield* viewOf(account);

          return customerOf(account, view);
        }),
        create: Effect.fn("Paykit.Customers.create")(function* (request) {
          return yield* created(account, request);
        }),
        getOrCreate: Effect.fn("Paykit.Customers.getOrCreate")(function* (request) {
          const view = yield* viewOf(account);

          // An existing customer is answered untouched: this is the sign-up
          // path, not a second way to state an identity (ADR 0045).
          if (view?.customer !== undefined) return customerOf(account, view);

          return yield* created(account, request);
        }),
        update: Effect.fn("Paykit.Customers.update")(function* (request) {
          const write = yield* setControls(account);

          // The write answers the view it waited for. Reading again would race
          // the projection and could report the customer before this write.
          const result = yield* write({ billingControls: request.billingControls });

          return customerOf(account, result.view);
        }),
      };
    });
  }),
);
