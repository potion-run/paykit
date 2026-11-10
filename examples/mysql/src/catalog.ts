import { Paykit } from "@potion.run/paykit";

/**
 * The catalog the deploy and the test share. Plain data, no
 * provider ids: the same declaration runs on `Manual`, Stripe or Polar and on
 * any store.
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

export const billingCatalog = { features: [messages], tiers: [free, pro] };
