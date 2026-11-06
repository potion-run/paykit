import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { tanstackCatalog } from "./catalog.ts";

/**
 * The one declaration every surface reads: the deploy, the Worker and the
 * browser client. The catalog is plain data; the provider and the store are
 * the deployment's choices.
 */
export const billing = {
  catalog: tanstackCatalog,
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
