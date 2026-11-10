import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/Postgres";
import { Paykit, postgresExecutor } from "@potion.run/paykit";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Provider } from "./billing.config.ts";
import { BillingHyperdrive } from "./Hyperdrive.ts";
import { billingOnPostgres } from "./SqlBilling.ts";

/**
 * One Worker on Postgres through Hyperdrive:
 *
 * - `/api`      — the tenant `BillingApi`.
 * - `/checkout` — ask `Manual` for an invoice.
 * - `/webhooks` — report that the manual provider has no delivery to verify.
 *
 * The connection is the two lines Alchemy's own Hyperdrive examples use:
 * `Cloudflare.Hyperdrive.Connect` resolves the binding, and
 * `@alchemy.run/sql/Postgres` builds the `@effect/sql-pg` client from its
 * connection string. The pool is memoized per execution, so it belongs to this
 * request and is closed when the event settles. `Paykit.postgresExecutor` is
 * the library's adapter from that client to the executor the SQL stores take.
 *
 * The schema is applied by the deploy's `MigrateBilling` action, never by a
 * request. A Worker that migrated on first use would race every other isolate.
 */
export default class PostgresWorker extends Cloudflare.Worker<PostgresWorker>()(
  "PaykitPostgresWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    // The resource is declared here, as Alchemy's Hyperdrive examples declare
    // it: at deploy it creates the configuration; at runtime it resolves the
    // same state, and `Connect` binds the runtime value.
    const connection = yield* BillingHyperdrive;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(connection);

    return {
      fetch: Effect.gen(function* () {
        const client = yield* SQL.Postgres({ url: hyperdrive.connectionString });
        const now = yield* Clock.currentTimeMillis;
        const { world } = billingOnPostgres(postgresExecutor(client), { now: () => now });

        const handler = yield* Paykit.handler({
          provider: Provider,
          accountOf: (request) => Paykit.accountFromHeaders(request.headers),
          surfaces: "tenant",
        }).pipe(Effect.provide(world), Effect.orDie);

        return yield* handler.fetch;
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding), Effect.orDie),
) {}
