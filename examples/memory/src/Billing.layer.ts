import { InsecureDevGuards, Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/**
 * The world the Worker and the test both serve: the model, the catalog, the
 * provider router and the tenant bindings, on `Domain.InMemory` and
 * `MemoryStore`.
 *
 * The only thing a real deployment changes is the platform and the store —
 * `billingOnSql` in `examples/billing` is the same world on D1. The guards are
 * the development header guards; a production deployment provides its own
 * session.
 */
export const MemoryLive = Paykit.world({
  ...billing,
  guards: InsecureDevGuards,
});
