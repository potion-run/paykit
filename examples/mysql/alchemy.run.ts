import { Paykit } from "@potion.run/paykit";
import { MySQL } from "@potion.run/paykit/Database/MySQL";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { billing } from "./src/billing.config.ts";

/**
 * A stack whose only deploy-time work is the billing schema on MySQL.
 *
 * `Paykit.registerMigrations` registers one Action keyed by the target's
 * identity, the shipped DDL and the dialect. A first deploy applies
 * `0001_init` and converges; a later deploy with a new column in
 * `BILLING_SCHEMA` adds it; an unchanged deploy does no database work. The
 * connection is read once here, so `MYSQL_URL` is a deploy secret and never a
 * value recorded in state.
 *
 * The model itself is hosted by whichever process runs it — a Bun service, a
 * Lambda, or a Worker through Hyperdrive — with `billingOnMysql(mysqlExecutor(client))`.
 */
const MySQLExample = Alchemy.Stack(
  "PaykitMySQLExample",
  {
    providers: Paykit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

    const url = yield* Config.Redacted("MYSQL_URL").pipe(Effect.orDie);
    const database = MySQL(url);

    yield* Paykit.registerMigrations("Billing").pipe(Effect.provide(database));

    return { tiers: recorded.tiers, model: Paykit.Model.modelName };
  }),
);

export default MySQLExample;
