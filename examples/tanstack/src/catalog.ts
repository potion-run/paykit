import { feature, plan, planItem } from "@potion.run/paykit/Read";

/**
 * The catalog. Plain data, no provider ids, so the same tiers sell through
 * `Manual`, Stripe or Polar.
 *
 * Only the Billing Worker imports it. The browser names a plan and the Worker
 * expands it with this value, so there is one catalog in the system and no
 * second copy to go stale.
 */
export const messages = feature({ id: "messages", name: "Messages" });

export const free = plan({
  id: "free",
  name: "Free",
  grants: [planItem(messages, { included: 100 })],
});

export const pro = plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [planItem(messages, { included: 2_000, overage: "bill" })],
});

export const tanstackCatalog = { features: [messages], tiers: [free, pro] };
