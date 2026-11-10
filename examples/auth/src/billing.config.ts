import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { authCatalog } from "./catalog.ts";

/**
 * `Manual` sells through an invoice, so the example needs no provider key.
 * Declaring it separately keeps its own type and leaves no positional read of
 * the world's provider list in user code.
 */
export const Provider = Paykit.Manual();

/**
 * The one declaration the deploy, the Worker and the test read. The catalog is
 * plain data; the provider and the store are the example's choices.
 */
export const billing = {
  catalog: authCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
