import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import { BillingHyperdrive } from "./src/Hyperdrive.ts";
import { MigrateBilling } from "./src/Migrate.ts";
import PostgresWorker from "./src/PostgresWorker.ts";

/**
 * A Cloudflare Worker whose billing database is Postgres behind Hyperdrive.
 *
 * `Cloudflare.Hyperdrive.Connection` reads `POSTGRES_URL` as an Effect, so the
 * connection string is resolved during deploy and never copied into state. The
 * `MigrateBilling` Action applies the committed migrations with Alchemy's SQL
 * registry (`@alchemy.run/sql/Migrations`) over `pg` before the Worker is
 * released; the Worker itself connects through Hyperdrive only.
 *
 * `Paykit.BillingStack` records the catalog and the Postgres store kind. The
 * record is deploy-time state; the Worker's runtime store is the SQL world in
 * `src/PostgresSql.ts`.
 */
const PostgresExample = Alchemy.Stack(
  "PaykitPostgresExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

    // `import.meta.url` is the stack file, so the directory resolves in the
    // example whether the CLI runs it from source or from a build.
    yield* MigrateBilling({ dir: new URL("./migrations", import.meta.url).pathname });

    const connection = yield* BillingHyperdrive;
    const worker = yield* PostgresWorker;

    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      hyperdrive: connection.hyperdriveId,
    };
  }),
);

export default PostgresExample;
