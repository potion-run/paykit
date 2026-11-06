import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { billingCatalog } from "./catalog.ts";

/**
 * The one declaration the deploy, the Worker and the tests read. The catalog is
 * plain data; the provider and the store are the example's choices.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
