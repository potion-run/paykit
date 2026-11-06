import { allowance, feature, tier } from "@potion.run/paykit/Read";

/**
 * The catalog. Plain data, no provider ids, so the same tiers sell through
 * `Manual`, Stripe or Polar. It is imported by both sides: the Billing Worker
 * validates it at deploy, and the browser joins its terms onto a tier change
 * the same way a server would.
 */
export const messages = feature({ id: "messages", name: "Messages" });

export const free = tier({
  id: "free",
  name: "Free",
  grants: [allowance(messages, { included: 100 })],
});

export const pro = tier({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});

export const tanstackCatalog = { features: [messages], tiers: [free, pro] };
