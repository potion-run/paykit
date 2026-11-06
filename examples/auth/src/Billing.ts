import { Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/** The catalog the deploy declares, for a test or a page that reads it. */
export const Catalog = billing.catalog;

/**
 * The provider the example runs: `Manual` sells through an invoice, so no
 * provider key is needed. Replacing this with `Polar(...)` or `Stripe(...)` is
 * the whole provider change.
 */
export const Provider = billing.providers[0]!;

/**
 * The billing world on `MemoryStore`, so the example needs no billing
 * database; the auth database is a D1 database beside it. The tenant and
 * operator bindings are both served from one model, and the guards are not
 * here: the Worker provides them from its session, so the same model serves any
 * identity provider.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  bindings: "both",
});
