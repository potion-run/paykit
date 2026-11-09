import { catalog, subscribeInputOf, PlanNotInCatalog } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { billing } from "../src/billing.config.ts";

/**
 * The validated catalog, for a test that sends a model command directly. The
 * deploy validates the same declaration; the binding takes `{ tier }`, so this
 * is only for the raw `BillingApi` client the tests exercise.
 */
export const Catalog = Effect.runSync(catalog(billing.catalog));

/** The full input a `Subscribe` command carries, or the model's refusal. */
export const tierCommand = (tierId: string) =>
  Effect.gen(function* () {
    const input = subscribeInputOf(Catalog, tierId);

    if (input === null) return yield* new PlanNotInCatalog({ tier: tierId });

    return input;
  });
