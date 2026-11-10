import { catalog, type Plan, PlanNotInCatalog, subscribeInputOf } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { billing } from "../src/billing.config.ts";

/** The validated catalog, for a test that sends a model command directly. */
export const Catalog = Effect.runSync(catalog(billing.catalog));

/** The full input a `Subscribe` command carries, from the plan declaration. */
export const subscribeInput = (plan: Plan) =>
  Effect.gen(function* () {
    const input = subscribeInputOf(Catalog, plan.id);

    if (input === null) return yield* new PlanNotInCatalog({ tier: plan.id });

    return input;
  });
