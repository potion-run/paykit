import { catalog, subscribeInputOf, TierNotInCatalog } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { billing } from "../src/billing.config.ts";

/** The validated catalog, for a test that sends a model command directly. */
export const Catalog = Effect.runSync(catalog(billing.catalog));

/** The full input a `Subscribe` command carries, or the model's refusal. */
export const tierCommand = (tierId: string) =>
  Effect.gen(function* () {
    const input = subscribeInputOf(Catalog, tierId);
    if (input === null) return yield* new TierNotInCatalog({ tier: tierId });
    return input;
  });
