import { InsecureDevGuards, Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/**
 * The billing world the Worker and the test both serve.
 *
 * `Paykit.world` builds the same graph a deployment uses: the model, the
 * catalog, the guards, the provider router and the tenant bindings. The only
 * difference is the platform — the Worker passes a Durable Object or SQL host,
 * the test takes the default `Domain.InMemory`. `Effect.orDie` at the Worker
 * boundary keeps a stack that cannot build from serving a degraded model.
 *
 * A named layer rather than an inline call so `BillingTestLive` has a type the
 * test can state: a test may require exactly what this world provides, and a
 * test that reaches for a service it does not serve is a compile error.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  guards: InsecureDevGuards,
});
