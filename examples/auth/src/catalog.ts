import { Paykit, type Plan } from "@potion.run/paykit";

/**
 * The catalog. Plain data, no provider ids, so the same tiers sell through
 * `Manual`, Stripe or Polar. The auth example keeps it small: the point of this
 * example is who may call the Api, not what the Api sells.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });

export const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});

export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});

export const authCatalog = { features: [messages], tiers: [free, pro] };

/**
 * The plan a request names, from the same array the deploy validates.
 *
 * A query string is a string; this is the one place it becomes a declaration,
 * so the checkout cannot send a tier the catalog does not sell — and the page
 * that advertises the link uses the plan's own id.
 */
export const planWithId = (id: string): Plan | null =>
  authCatalog.tiers.find((plan) => plan.id === id) ?? null;
