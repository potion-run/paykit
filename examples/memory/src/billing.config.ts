import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { billingCatalog } from "./catalog.ts";

/**
 * `Manual` sells through an invoice, so the example needs no provider key. It
 * is a declaration of its own, so the provider keeps its own type rather than
 * being read out of an array.
 */
export const Provider = Paykit.Manual();

/**
 * The one declaration the deploy, the Worker and the test read. `MemoryStore`
 * means the model runs with no database at all: a process restart is a fresh
 * ledger, which is exactly what a quickstart wants and what a deployment must
 * not keep.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
