import { Paykit } from "@potion.run/paykit";

/**
 * The catalog the example deploys. It is plain data; `Stack` validates it, and
 * the console reads it back through `AdminReads.Catalog`.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });
export const seats = Paykit.feature({ id: "seats", name: "Seats" });

export const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 }), Paykit.planItem(seats, { included: 1 })],
});

export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [
    Paykit.planItem(messages, { included: 2_000, overage: "bill" }),
    Paykit.planItem(seats, { included: 5, resets: "never" }),
  ],
});

export const scale = Paykit.plan({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [
    Paykit.planItem(messages, { included: 20_000, overage: "bill" }),
    Paykit.planItem(seats, { included: 25, resets: "never" }),
  ],
});

export const adminCatalog = { features: [messages, seats], tiers: [free, pro, scale] };
