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
 * `Paykit.MySQL` records the deploy-time store kind. The URL is a `Config`, so
 * the connection string stays a secret and never reaches state; the test reads
 * `MYSQL_URL` itself.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.MySQL({ url: Config.Redacted("MYSQL_URL") }),
} satisfies BillingStackProps;
