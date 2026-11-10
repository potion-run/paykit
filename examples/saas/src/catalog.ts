import { Paykit } from "@potion.run/paykit";

/**
 * The product's catalog: what the support desk sells, in plain data with no
 * provider ids. `Paykit.BillingStack` validates this at deploy, so a plan that
 * grants a feature nobody declared, prices a unit in the wrong currency or
 * names an add-on that is not one is a deploy error rather than a broken
 * checkout.
 *
 * The shape is every metered SaaS: a workspace pays for a pool of conversations,
 * per-seat access, and a bucket of credits that model calls spend. What the
 * example adds is the part a real deployment needs and a pricing page does not
 * show — a shared pool across projects, a per-project grant, an add-on, a spend
 * ceiling and a usage alert.
 */

/** One resolved support conversation. The org's plan shares one pool of them. */
export const conversations = Paykit.feature({ id: "conversations", name: "Conversations" });

/**
 * What a model call costs, in credits. The feature and the caller's estimate
 * read this one table, so the price a turn is quoted at cannot drift from the
 * rate the pool is charged.
 */
export const AI_RATES = { default: 1, "gpt-large": 10 } as const;

export type AiModel = keyof typeof AI_RATES;

/** The credits one call on a model costs. */
export const aiCostOf = (model: AiModel): number => AI_RATES[model];

/**
 * Model calls, priced in credits rather than their own count: a small model
 * costs one credit, the large one ten. The pool is the plan's `credits`, and
 * every credit-priced feature spends the same pool (ADR 0002).
 */
export const ai = Paykit.feature({
  id: "ai",
  name: "AI",
  creditRates: AI_RATES,
});

/** A person who can answer conversations: bought, then occupied (ADR 0036). */
export const seats = Paykit.feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/** An on/off capability. A flag is granted, never metered or set. */
export const sso = Paykit.feature({ id: "sso", name: "SSO", kind: "flag" });

/**
 * The plan an account gets on sign-up. `isDefault` is what makes it the plan a
 * customer with none is put on, and what a cancelled group falls back to.
 */
export const free = Paykit.plan({
  id: "free",
  name: "Free",
  isDefault: true,
  grants: [
    Paykit.planItem(conversations, { included: 100 }),
    Paykit.planItem(seats, { included: 1, resets: "never" }),
  ],
});

/**
 * The paid plan. `conversations` is `pooled`, so every project attached to the
 * account draws on one shared source (ADR 0040 §3): the org pays once and the
 * projects cannot each report their own copy of it.
 *
 * Past the 2,000 included, a conversation bills two cents, up to 10,000 more
 * this period. What the month did not spend rolls over, at most 5,000 extra.
 */
export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [
    Paykit.planItem(conversations, {
      included: 2_000,
      overage: "bill",
      cap: 10_000,
      unitPrice: { amount: 2, currency: "usd" },
      carryOver: true,
      carryCap: 5_000,
      pooled: true,
    }),
    Paykit.planItem(seats, { included: 5, resets: "never" }),
  ],
});

/**
 * The top plan: unlimited conversations on the same shared pool, a larger
 * credit bucket and SSO. An `"unlimited"` allowance cannot state a cap or a
 * price, because there is no end to bill past.
 */
export const scale = Paykit.plan({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  credits: 50_000,
  grants: [
    Paykit.planItem(conversations, { included: "unlimited", pooled: true }),
    Paykit.planItem(seats, { included: 25, resets: "never" }),
    Paykit.grant(sso),
  ],
});

/**
 * An add-on: it stacks beside whatever plan the group holds instead of
 * replacing it (ADR 0039 §2). Attached on a project, it gives that project its
 * own allowance before the shared pool, which is how one team buys capacity
 * without repricing everyone.
 */
export const studio = Paykit.plan({
  id: "studio",
  name: "Studio add-on",
  group: "support",
  addOn: true,
  grants: [
    Paykit.planItem(conversations, { included: 500 }),
    Paykit.planItem(seats, { included: 2, resets: "never" }),
  ],
});

/** The catalog the deploy validates and the model runs with. */
export const saasCatalog = {
  features: [conversations, ai, seats, sso],
  tiers: [free, pro, scale, studio],
};
