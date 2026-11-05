import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The billing database: one D1 database with paykit's schema as migration
 * files, applied on deploy in filename order.
 *
 * Every `migrations/*.sql` file is generated from `Paykit.migrationFiles`, so
 * the DDL a deploy runs and the DDL a test runs cannot drift:
 *
 * ```sh
 * node packages/paykit/scripts/schema.ts sqlite --file=0001_init > examples/billing/migrations/0001_init.sql
 * ```
 *
 * The first file is `IF NOT EXISTS` throughout; later files are additive and
 * forward-only. Never edit a file a deployment already applied — append one.
 */
export const BillingDatabase = Cloudflare.D1.Database("BillingDatabase", {
  migrations: "./migrations",
});
