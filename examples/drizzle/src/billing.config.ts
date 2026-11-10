import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import * as Config from "effect/Config";
import { billingCatalog } from "./catalog.ts";

/**
 * `Manual` sells through an invoice, so the example needs no provider key.
 * Declaring it separately keeps its own type and leaves no positional read of
 * the world's provider list in user code.
 */
export const Provider = Paykit.Manual();

/**
 * The one declaration the deploy and the test read.
 *
 * `Paykit.Postgres` records the deploy-time store kind: the schema is what a
 * later deploy diffs, and the URL stays a `Config`. The connection itself is the
 * Drizzle pool, which is a runtime binding, not state.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.Postgres({ url: Config.Redacted("POSTGRES_URL"), schema: "billing" }),
} satisfies BillingStackProps;
