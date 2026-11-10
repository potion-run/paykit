import { InsecureDevGuards, Paykit } from "@potion.run/paykit";
import { billing, refill } from "./billing.config.ts";

/**
 * The world the Worker and the tests both serve: the model, the catalog, the
 * provider router and the tenant bindings, on `Domain.InMemory`.
 *
 * The only thing a deployment changes is the platform and the store —
 * `billingOnSql` in `src/SqlBilling.ts` is the same world on D1. The guards are
 * the development header guards; a production deployment provides its own
 * session, as `examples/auth` does with Better Auth.
 *
 * A named layer rather than an inline `Paykit.world` call so `SaasLive` has a
 * type a test can state: a test that reaches for a service this world does not
 * serve is a compile error, not a runtime surprise.
 */
export const SaasLive = Paykit.world({
  ...billing,
  guards: InsecureDevGuards,
  autoTopUp: refill,
});
