import { Paykit } from "@potion.run/paykit";

/**
 * The catalog. Three declarations, plain data, no provider ids: the same
 * catalog runs on `Manual`, Stripe or Polar. `Stack` validates this at deploy,
 * so a tier that grants a feature nobody declared is a deploy error rather
 * than a broken checkout.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });
export const seats = Paykit.feature({ id: "seats", name: "Seats" });

/**
 * An on/off capability. A flag is granted with `grant()`, not metered with
 * `allowance()`: there is no count behind it, so `check()` answers allowed and
 * `Track` refuses it.
 */
export const sso = Paykit.feature({ id: "sso", name: "SSO", kind: "flag" });

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
    // Unlimited: `overage` defaults to "allow", because past an allowance that
    // never runs out there is nothing to block and nothing to bill. `check()`
    // reports `remaining: null`, and the period still resets on schedule.
    Paykit.allowance(messages, { included: "unlimited" }),
    Paykit.grant(sso),
    Paykit.allowance(seats, { included: 25, resets: "never" }),
  ],
});

export const billingCatalog = { features: [messages, seats, sso], tiers: [free, pro, scale] };
