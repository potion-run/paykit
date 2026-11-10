import { InsecureDevGuards, Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/**
 * The world a Worker and a Node process both serve: the model, the catalog, the
 * provider router and the tenant bindings, on `Domain.InMemory` and
 * `MemoryStore`.
 *
 * The only thing a deployment changes is the platform, the store and the guards.
 * A Node host that owns a Postgres pool passes `billingOnSql` the executor that
 * pool yields; this example keeps the smallest world so the host file is the
 * only thing to read.
 */
export const MemoryLive = Paykit.world({
  ...billing,
  guards: InsecureDevGuards,
});
