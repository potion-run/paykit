import { Paykit, type BillingStackProps } from "@potion.run/paykit";
import { billingCatalog } from "./catalog.ts";

/**
 * The provider the example runs by default: `Manual` sells through an invoice,
 * so the example needs no key and no account. Swapping in
 * `Polar({ ..., webhookSecret })` or `Stripe({ ..., webhookSecret })` lights up
 * the checkout and webhook routes and nothing else moves.
 *
 * It is a declaration of its own rather than a read of `providers[0]`, so the
 * type is the provider's own — `MoneyProvider<"manual">` — everywhere it is
 * imported.
 */
export const Provider = Paykit.Manual();

/**
 * The one declaration the deploy, the Worker and the tests read. The catalog is
 * plain data; the provider and the store are the example's choices.
 *
 * `store` is the deploy-time record, not the Worker's runtime store: the
 * database is the D1 resource beside this file, and `billingOnSql` hosts the
 * model on it. It records `D1Store`, so a later deploy can see the ledger's
 * store kind even though the binding is a runtime value.
 *
 * `satisfies` keeps the declaration's own types: `providers` stays a one-element
 * tuple whose element is `Provider`, not a widened `MoneyProvider[]`.
 */
export const billing = {
  catalog: billingCatalog,
  providers: [Provider],
  store: Paykit.D1Store(),
} satisfies BillingStackProps;
