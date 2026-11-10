import { describe, expect, it } from "@alchemy.run/test";
import { Check, moneyRoutes, Paykit, type MoneyProvider } from "@potion.run/paykit";
import type { StripeClient } from "@potion.run/paykit-stripe";
import * as Effect from "effect/Effect";
import { providerOf, worldOptions, type StripeEnv } from "../src/Billing.ts";
import { pro, proPrice } from "../src/catalog.ts";

const account = "acct_stripe_example";
const secret = "whsec_stripe_example_secret";

const env: StripeEnv = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_PRICE_PRO: "paykit_dev_pro",
  STRIPE_MESSAGES_PRICE: "paykit_dev_messages",
  STRIPE_MESSAGES_METER: "paykit_dev_messages",
};

/** A stand-in for Stripe: no key, no account, the same calls a deployment makes. */
const recording = (asked: Array<Record<string, unknown>> = []): StripeClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request);

      return { url: `https://checkout.stripe.test/${request.priceIds.join(",")}` };
    }),
  createBillingPortalSession: () => Effect.sync(() => ({ url: "https://billing.stripe.test" })),
  createInvoice: () => Effect.sync(() => ({ invoiceId: "in_example" })),
  resolvePrice: (lookupKey) => Effect.sync(() => `price_${lookupKey}`),
  reportUsage: () => Effect.sync(() => ({})),
});

const provider = (asked: Array<Record<string, unknown>> = []): MoneyProvider<"processor"> =>
  providerOf(env, recording(asked));

/** The world a test serves, built around the provider the test also routes. */
const worldOf = (provider: MoneyProvider) => Effect.provide(Paykit.world(worldOptions(provider)));

/** Stripe's signed string is `"<timestamp>.<body>"`, hex, in the header. */
const signed = (body: unknown): { headers: Record<string, string>; body: string } => {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor((performance.timeOrigin + performance.now()) / 1000));

  const tag = new Bun.CryptoHasher("sha256", new TextEncoder().encode(secret))
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return {
    headers: { "stripe-signature": `t=${timestamp},v1=${tag}` },
    body: payload,
  };
};

const orderPaid = (patch: Record<string, unknown> = {}) => ({
  id: "evt_example",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_example",
      customer: account,
      client_reference_id: account,
      amount_total: 1900,
      currency: "usd",
      metadata: { tier: pro.id },
      payment_intent: "pi_example",
      ...patch,
    },
  },
});

describe("the Stripe example", () => {
  it("maps the catalog price and the deployed lookup keys onto the provider", () => {
    const stripe = provider();

    expect(stripe.prices).toEqual({ pro: proPrice });
    expect(stripe.capabilities.has("checkout")).toBe(true);
    expect(stripe.capabilities.has("usage")).toBe(true);
    expect(stripe.webhook).toBeDefined();
  });

  it.live("a purchase is a checkout, and the signed delivery activates the tier", () => {
    const asked: Array<Record<string, unknown>> = [];
    const stripe = provider(asked);

    return Effect.gen(function* () {
      const routes = yield* moneyRoutes(stripe);

      // 1. The route asks Stripe for a path to pay. The lookup key was resolved
      // to the price that answers for the tier now.
      const purchase = yield* routes.purchase(account, pro.id);
      expect("url" in purchase).toBe(true);

      if ("url" in purchase) expect(purchase.url).toContain(`price_${env.STRIPE_PRICE_PRO}`);

      // The checkout carries the base price and the metered price together, so
      // a meter event later has a price to bill.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.priceIds).toEqual([
        `price_${env.STRIPE_PRICE_PRO}`,
        `price_${env.STRIPE_MESSAGES_PRICE}`,
      ]);

      // 2. Stripe says it was paid, signed with its own secret.
      const applied = yield* routes.deliver(signed(orderPaid()));
      expect(applied.action).toBe("activated");
      expect(applied.eventId).toBe("evt_example");

      // 3. The entitlement answers from local state, no provider in the read.
      const check = yield* Check(account);
      let answer = yield* check({ featureId: "messages", requiredBalance: 1 });

      // A view is fed by deliveries, so the read catches up just after the
      // command commits.
      for (let attempt = 0; attempt < 500 && !answer.allowed; attempt++) {
        yield* Effect.sleep("10 millis");
        answer = yield* check({ featureId: "messages", requiredBalance: 1 });
      }

      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(2_000);
    }).pipe(worldOf(stripe));
  });

  it.live("a tampered delivery never reaches the model", () => {
    const stripe = provider();

    return Effect.gen(function* () {
      const routes = yield* moneyRoutes(stripe);
      const delivery = signed(orderPaid());
      const tampered = { ...delivery, body: delivery.body.replace("1900", "1") };
      const error = yield* Effect.flip(routes.deliver(tampered));

      expect(error._tag).toBe("WebhookSignatureInvalid");
    }).pipe(worldOf(stripe));
  });

  it.live("an event paykit does not model is acknowledged and ignored", () => {
    const stripe = provider();

    return Effect.gen(function* () {
      const routes = yield* moneyRoutes(stripe);

      const applied = yield* routes.deliver(
        signed({ id: "evt_ignored", type: "customer.created", data: { object: {} } }),
      );

      expect(applied).toEqual({ action: "ignored", eventId: null });
    }).pipe(worldOf(stripe));
  });

  it.live("a checkout with no tier cannot activate, and names the field", () => {
    const stripe = provider();

    return Effect.gen(function* () {
      const routes = yield* moneyRoutes(stripe);

      const error = yield* Effect.flip(routes.deliver(signed(orderPaid({ metadata: {} }))));

      // The decoder refused to invent a tier; a paid session with no standing
      // cannot activate without one. The route answers 400, which is a support
      // ticket rather than a silently free month.
      expect(error._tag).toBe("WebhookInvalid");

      if (error._tag === "WebhookInvalid") expect(error.field).toBe("tier");
    }).pipe(worldOf(stripe));
  });
});
