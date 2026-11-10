import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The billing database. The schema is not a directory of `.sql` files: the
 * deploy applies `Paykit.migrationFiles()` through the D1 HTTP API and then
 * converges it, so the DDL a test runs and the DDL a deploy runs are the same
 * rendering of `BILLING_SCHEMA`.
 *
 * Do not give this resource a `migrations` prop as well — that would be a second
 * migrator for one schema.
 */
export const BillingDatabase = Cloudflare.D1.Database("BillingDatabase");
