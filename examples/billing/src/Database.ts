import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The billing database: one D1 database with paykit's schema as a migration
 * file, applied on deploy.
 *
 * `migrations/0001_init.sql` is generated from `Paykit.migrationFiles`, so the
 * DDL a deploy runs and the DDL a test runs cannot drift:
 *
 * ```sh
 * pnpm --filter @potion.run/paykit schema > examples/billing/migrations/0001_init.sql
 * ```
 *
 * The statements are `IF NOT EXISTS` throughout, so re-running the file is a
 * no-op — which is what makes it safe to apply on every deploy.
 */
export const BillingDatabase = Cloudflare.D1.Database("BillingDatabase", {
  migrations: "./migrations",
});
