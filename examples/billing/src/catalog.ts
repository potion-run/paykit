import { Paykit } from "@potion.run/paykit";

/**
 * The catalog. Three declarations, plain data, no provider ids: the same
 * catalog runs on `Manual`, Stripe or Polar. `Stack` validates this at deploy,
 * so a tier that grants a feature nobody declared is a deploy error rather
 * than a broken checkout.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });
export const seats = Paykit.feature({ id: "seats", name: "Seats" });

export const free = Paykit.tier({
  id: "free",
  name: "Free",
  grants: [Paykit.allowance(messages, { included: 100 }), Paykit.allowance(seats, { included: 1 })],
});

export const pro = Paykit.tier({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [
    Paykit.allowance(messages, { included: 2_000, overage: "bill" }),
    Paykit.allowance(seats, { included: 5, resets: "never" }),
  ],
});

export const scale = Paykit.tier({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [
    Paykit.allowance(messages, { included: 20_000, overage: "bill" }),
    Paykit.allowance(seats, { included: 25, resets: "never" }),
  ],
});

export const billingCatalog = { features: [messages, seats], tiers: [free, pro, scale] };
