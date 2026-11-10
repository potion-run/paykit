import { Paykit } from "@potion.run/paykit";

/**
 * The catalog the deploy, the Worker and the test share. It is plain data and
 * carries no Stripe id: the price here is the same price `StripeBilling` copies
 * onto the price and meter it creates.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });

export const proPrice = { amount: 1900, currency: "usd", interval: "month" } as const;
export const messagePrice = { amount: 2, currency: "usd" } as const;

export const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});

export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: proPrice,
  grants: [
    Paykit.planItem(messages, {
      included: 2_000,
      overage: "bill",
      unitPrice: messagePrice,
    }),
  ],
});

export const billingCatalog = { features: [messages], tiers: [free, pro] };

/** The tier map `StripeBilling` provisions and the provider sells. */
export const stripeTiers = {
  pro: {
    price: proPrice,
    usage: { messages: messagePrice },
  },
};
