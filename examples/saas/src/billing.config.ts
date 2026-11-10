import { type BillingStackProps, Paykit } from "@potion.run/paykit";
import { credits100k, saasCatalog } from "./catalog.ts";

/**
 * The money provider the example runs by default.
 *
 * `Memory()` has the whole capability set and moves no money, which is what a
 * keyless example needs: the purchase, the refill, the portal and the refund
 * all answer, and the deploy still validates every plan's price against a
 * provider that can sell it. It is not a production provider — swap it for
 * `Stripe({ tiers, meters, webhookSecret })` from `@potion.run/paykit-stripe`
 * and nothing else in this file moves (`examples/stripe` is that deploy).
 *
 * `Manual()` is the other honest keyless choice, but it sells through an
 * invoice and cannot charge a saved method, so the refill line would record
 * `TopUpFailed` instead of buying the pack.
 */
export const Provider = Paykit.Memory();

/**
 * The auto top-up policy's fallback: the pack a tier buys when its own line
 * names none. A tier's line is catalog data, but installing the policy is the
 * deployment's call — without it a crossing records nothing and the line is
 * inert. The tier's own `pack` and `cooldown` win over these.
 */
export const refill = { pack: credits100k.id } as const;

/**
 * The one declaration the deploy, the Worker and the tests read. The catalog is
 * plain data; the provider and the store are the example's choices.
 *
 * `store` is the deploy-time record, not the Worker's runtime store: the
 * database is the D1 resource beside this file, and `billingOn` hosts the model
 * on it. The SQL test uses the same function, which is why this file can keep
 * `MemoryStore` without making the Worker in-memory.
 *
 * `satisfies` keeps the declaration's own types: `providers` stays a one-element
 * tuple whose element is `Provider`, not a widened `MoneyProvider[]`.
 */
export const billing = {
  catalog: saasCatalog,
  providers: [Provider],
  store: Paykit.MemoryStore(),
} satisfies BillingStackProps;
