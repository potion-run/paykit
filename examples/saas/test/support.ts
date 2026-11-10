import {
  BillingApi,
  catalog,
  Entitlements,
  type Plan,
  PlanNotInCatalog,
  type PlanItem,
  Subscription,
  subscribeInputOf,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { billing } from "../src/billing.config.ts";

/**
 * The validated catalog, for a test that sends a raw `BillingApi` command. The
 * deploy validates the same declaration; `Workspace` and `Agent` take the
 * declarations instead, so this is only for the tests that seed a standing.
 */
export const Catalog = Effect.runSync(catalog(billing.catalog));

/** The aggregate key and the Api target are the same branded id. */
export const account = Subscription.ref("acct_saas");

/** The dev guards read these; a real deployment replaces them with a session. */
export const asAccount = { headers: { "x-paykit-actor": account.id } };

/**
 * The full input a `Subscribe` command carries, from the plan declaration.
 *
 * A command has to carry its own allowances and price because `decide` is pure
 * and cannot look them up, so `CatalogGuard` refuses any command whose
 * allowances or price disagree with the catalog the deployment validated. The
 * join lives here, in one place, and takes the plan rather than an id: a plan
 * that is not in the catalog is a declaration mistake, not a caller typo.
 */
export const subscribeInput = (plan: Plan) =>
  Effect.gen(function* () {
    const input = subscribeInputOf(Catalog, plan.id);

    if (input === null) return yield* new PlanNotInCatalog({ tier: plan.id });

    return input;
  });

/**
 * Activate a plan through the tenant Api's own `Subscribe` command, as a
 * settled checkout would. The purchase path (`Attach` on a priced plan) answers
 * the provider's checkout, and activation waits for its webhook, so a test about
 * what the model does once the account is subscribed seeds the standing here
 * rather than standing in for a payment.
 */
export const activate = (plan: Plan) =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;
    const receipt = yield* tenant.Subscribe(account.id, yield* subscribeInput(plan), asAccount);
    const entitlements = yield* Entitlements;

    yield* entitlements.query(account, { atLeast: receipt });
  });

/** One account's entitlement row, read after the commands have committed. */
export const entitlementsOf = Effect.gen(function* () {
  const entitlements = yield* Entitlements;

  return yield* entitlements.query(account);
}).pipe(Effect.map(Option.getOrNull));

/** The allowance one plan grants a feature, as the catalog states it. */
export const itemOf = (plan: Plan, featureId: string): PlanItem => {
  const item = plan.grants.find((grant) => grant.feature === featureId);

  if (item === undefined) throw new Error(`${plan.id} does not grant ${featureId}`);

  return item;
};
