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
 * The one declaration the deploy, the Worker and the test read.
 *
 * `Paykit.Postgres` records the deploy-time store kind. The URL is a `Config`,
 * so the connection string stays a runtime secret and never reaches state.
 * The Worker reaches Postgres through Hyperdrive, not this URL; the deploy
 * records the kind so a later deploy can diff it.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.Postgres({ url: Config.Redacted("POSTGRES_URL"), schema: "billing" }),
} satisfies BillingStackProps;
