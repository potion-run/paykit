import { catalog, type Plan, PlanNotInCatalog, subscribeInputOf } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { billing } from "../src/billing.config.ts";

/**
 * The validated catalog, for a test that sends a raw `BillingApi` command. The
 * deploy validates the same declaration; the typed `Tenant` facade takes the
 * declarations instead, so this is only for the tests that exercise the wire
 * surface itself.
 */
export const Catalog = Effect.runSync(catalog(billing.catalog));

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
