import { Paykit } from "@potion.run/paykit";

/**
 * The catalog. Plain data, no provider ids, so the same tiers sell through
 * `Manual`, Stripe or Polar. The auth example keeps it small: the point of this
 * example is who may call the Api, not what the Api sells.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });

export const free = Paykit.tier({
  id: "free",
  name: "Free",
  grants: [Paykit.allowance(messages, { included: 100 })],
});

export const pro = Paykit.tier({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.allowance(messages, { included: 2_000, overage: "bill" })],
});

export const authCatalog = { features: [messages], tiers: [free, pro] };
