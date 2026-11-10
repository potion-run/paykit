import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { billingCatalog } from "./catalog.ts";

/**
 * `Manual` sells through an invoice, so the Node host needs no provider key.
 * The provider is declared once here and shared by the server and the test, so
 * neither can drift from the other.
 */
export const Provider = Paykit.Manual();

/**
 * The one declaration the host and the test read.
 *
 * `MemoryStore` keeps the example about the host: there is no database to
 * provision and no deploy resource to record. Replace it with
 * `Paykit.Sqlite(...)` under Bun, or `Paykit.Database.Drizzle` over the pool a
 * Node process already opened, and the server below does not change — the
 * executor comes from `Paykit.Database`, not from the host file.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
