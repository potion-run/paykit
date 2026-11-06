import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { adminCatalog } from "./catalog.ts";

/**
 * The one declaration the deploy, the Worker and the test read. The catalog is
 * plain data; the provider and the store are the example's choices.
 */
export const billing = {
  catalog: adminCatalog,
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
