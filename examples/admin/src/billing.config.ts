import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { adminCatalog } from "./catalog.ts";

/** `Manual` sells through an invoice; a declaration of its own, not a positional read. */
export const Provider = Paykit.Manual();

/**
 * The one declaration the deploy, the Worker and the test read. The catalog is
 * plain data; the provider and the store are the example's choices.
 */
export const billing = {
  catalog: adminCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
