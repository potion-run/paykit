import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { tanstackCatalog } from "./catalog.ts";

/** `Manual` sells through an invoice; a declaration of its own, not a positional read. */
export const Provider = Paykit.Manual();

/**
 * The one declaration every surface reads: the deploy, the Worker and the
 * server-side plan join. The catalog is plain data; the provider and the store
 * are the deployment's choices.
 */
export const billing = {
  catalog: tanstackCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
