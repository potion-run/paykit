import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import { Postgres } from "@potion.run/paykit/Database/Postgres";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import { BillingHyperdrive } from "./src/Hyperdrive.ts";
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
    // The deploy's own connection. `POSTGRES_URL` is read once here, so the
    // connection string is a deploy secret and the Worker keeps reaching
    // Postgres through Hyperdrive. A literal or `Redacted` source is
    // deploy-resolvable, so `Postgres` offers it to migrations by default.
    const url = yield* Config.Redacted("POSTGRES_URL").pipe(Effect.orDie);

    // `migrate: true` plus the layer is the whole migration: one Action keyed
    // by the target's identity and the shipped fingerprints. A changed table or
    // a different database re-runs it; an unchanged deploy is a no-op.
    const recorded = yield* Paykit.BillingStack("Billing", { ...billing, migrate: true }).pipe(
      Effect.provide(Postgres(url, { schema: "billing" })),
      Effect.orDie,
    );

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
