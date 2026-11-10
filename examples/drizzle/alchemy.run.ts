import { Paykit } from "@potion.run/paykit";
import { Drizzle } from "@potion.run/paykit/Database/Drizzle";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { billing } from "./src/billing.config.ts";
import { openDrizzle } from "./src/Drizzle.ts";

/**
 * A stack whose deploy-time work is the billing schema on the Postgres pool a
 * Drizzle instance already opened.
 *
 * paykit never uses Drizzle's query builder: `BILLING_SCHEMA` is still the
 * source of the DDL and the stores still write SQL. What the application gains
 * is one connection — the pool Drizzle holds — with paykit's migration Action
 * and its stores running on it.
 */
const DrizzleExample = Alchemy.Stack(
  "PaykitDrizzleExample",
  {
    providers: Paykit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

    const url = yield* Config.Redacted("POSTGRES_URL").pipe(Effect.orDie);
    const { db } = openDrizzle(Redacted.value(url));

    // The layer unwraps `db.$client` and gives paykit the pool's executor, so a
    // migration and a request share one connection boundary.
    const database = Drizzle(db, { schema: "billing" });

    yield* Paykit.registerMigrations("Billing").pipe(Effect.provide(database));

    return { tiers: recorded.tiers, model: Paykit.Model.modelName };
  }),
);

export default DrizzleExample;
