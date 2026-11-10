import { Paykit } from "@potion.run/paykit";

/**
 * The catalog. Three declarations, plain data, no provider ids: the same
 * catalog runs on `Manual`, Stripe or Polar. `Stack` validates this at deploy,
 * so a tier that grants a feature nobody declared is a deploy error rather
 * than a broken checkout.
 *
 * Every declaration here is also the only way the example names it: `Tenant`
 * takes the `Feature` and `Plan` values rather than their ids, so a name that
 * is not a declaration does not type-check, and a feature's `kind` decides
 * which verbs accept it.
 */
export const messages = Paykit.feature({ id: "messages", name: "Messages" });

/**
 * A quantity: the account holds a purchased count and reports how many are in
 * use, and the two are different facts. A quantity is set with `SetQuantity`
 * and `SetUsage`, never spent, which is why `kind` is part of the declaration.
 */
export const seats = Paykit.feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/**
 * An on/off capability. A flag is granted with `grant()`, not metered with
 * `allowance()`: there is no count behind it, so `check()` answers allowed and
 * `Track` refuses it.
 *
 * The `kind` is part of the declaration's type, which is how `Tenant.track`
 * rejects a flag at compile time instead of recording nothing at runtime.
 */
export const sso = Paykit.feature({ id: "sso", name: "SSO", kind: "flag" });

/**
 * A feature priced in credits: a unit costs credits by the dimension that
 * served it, and every credit-priced feature spends the one pool the tier
 * grants. There is no allowance for it, because the pool is the count.
 */
export const ai = Paykit.feature({
  id: "ai",
  name: "AI",
  creditRates: { default: 1, "gpt-large": 10 },
});

/** The price `pro` is sold at and the provider sells, stated once. */
export const proPrice = { amount: 1900, currency: "usd", interval: "month" } as const;

export const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 }), Paykit.planItem(seats, { included: 1 })],
});

export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: proPrice,
  grants: [
    // Rollover: what the month did not spend carries into the next one, at most
    // one month's worth. `check()` reports the carried amount as `remaining`.
    // A cap, in messages, stops the billing at 2,000 included plus 10,000 more
    // this month: past that `check()` says no until the period resets.
    Paykit.planItem(messages, { included: 2_000, overage: "bill", carryOver: true, cap: 10_000 }),
    Paykit.planItem(seats, { included: 5, resets: "never" }),
  ],
});

export const scale = Paykit.plan({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  // The pool `ai` spends from, granted when the tier activates and expired at
  // the period close (the default).
  credits: 50_000,
  grants: [
    // Unlimited: `overage` defaults to "allow", because past an allowance that
    // never runs out there is nothing to block and nothing to bill. `check()`
    // reports `remaining: null`, and the period still resets on schedule.
    Paykit.planItem(messages, { included: "unlimited" }),
    Paykit.grant(sso),
    Paykit.planItem(seats, { included: 25, resets: "never" }),
  ],
});

export const billingCatalog = { features: [messages, seats, sso, ai], tiers: [free, pro, scale] };
