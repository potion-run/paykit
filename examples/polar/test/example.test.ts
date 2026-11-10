import { describe, expect, it } from "@alchemy.run/test";
import { Check, moneyRoutes, Paykit } from "@potion.run/paykit";
import type { PolarClient } from "@potion.run/paykit-polar";
import * as Effect from "effect/Effect";
import { providerOf, worldOptions, type PolarEnv } from "../src/Billing.ts";
import { pro, proPrice } from "../src/catalog.ts";

const account = "acct_polar_example";
const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const env: PolarEnv = {
  POLAR_API_KEY: "polar_test",
  POLAR_WEBHOOK_SECRET: secret,
  POLAR_PRODUCT_PRO: "prod_example",
  POLAR_MESSAGES_METER: "paykit_test_messages",
};

/** A stand-in for Polar: no key, no account, the same calls a deployment makes. */
const recording = (asked: Array<Record<string, unknown>> = []): PolarClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request);

      return { url: `https://polar.test/checkout/${request.productId}` };
    }),
  createCustomerSession: () => Effect.sync(() => ({ url: "https://polar.test/portal" })),
  createInvoice: () => Effect.sync(() => ({ invoiceId: "ord_proration" })),
  createRefund: () => Effect.sync(() => ({ refundId: "re_test" })),
  reportUsage: () => Effect.sync(() => ({})),
});

const provider = providerOf(env, recording());
const world = Paykit.world(worldOptions(provider));

/** An independent HMAC over Polar's signed string, as a delivery would carry. */
const signed = (body: unknown): { headers: Record<string, string>; body: string } => {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(performance.timeOrigin + performance.now()) / 1000);

  const tag = new Bun.CryptoHasher("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${"msg_polar_example"}.${timestamp}.${payload}`)
    .digest("base64");

  return {
    headers: {
      "webhook-id": "msg_polar_example",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${tag}`,
    },
    body: payload,
  };
};

const orderPaid = (patch: Record<string, unknown> = {}) => ({
  type: "order.paid",
  data: {
    id: "ord_example",
    status: "paid",
    product_id: env.POLAR_PRODUCT_PRO,
    total_amount: 1900,
    currency: "usd",
    customer: { id: "cus_example", external_id: account },
    ...patch,
  },
});

describe("the Polar example", () => {
  it("maps the catalog price and the deployed product onto the provider", () => {
    expect(provider.prices).toEqual({ pro: proPrice });
    expect(provider.capabilities.has("checkout")).toBe(true);
    expect(provider.capabilities.has("usage")).toBe(true);
    expect(provider.webhook).toBeDefined();
  });

  it.live("a purchase is a checkout, and the signed delivery activates the tier", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(provider);

      const purchase = yield* routes.purchase(account, pro.id);
      expect("url" in purchase).toBe(true);

      if ("url" in purchase) expect(purchase.url).toContain(env.POLAR_PRODUCT_PRO);

      const applied = yield* routes.deliver(signed(orderPaid()));
      expect(applied.action).toBe("activated");
      expect(applied.eventId).toBe("msg_polar_example");

      const check = yield* Check(account);
      let answer = yield* check({ featureId: "messages", requiredBalance: 1 });

      // A view catches up just after the command commits.
      for (let attempt = 0; attempt < 500 && !answer.allowed; attempt++) {
        yield* Effect.sleep("10 millis");
        answer = yield* check({ featureId: "messages", requiredBalance: 1 });
      }

      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(2_000);
    }).pipe(Effect.provide(world)),
  );

  it.live("a tampered delivery never reaches the model", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(provider);
      const delivery = signed(orderPaid());
      const tampered = { ...delivery, body: delivery.body.replace("1900", "1") };
      const error = yield* Effect.flip(routes.deliver(tampered));
      expect(error._tag).toBe("WebhookSignatureInvalid");
    }).pipe(Effect.provide(world)),
  );

  it.live("an event paykit does not model is acknowledged and ignored", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(provider);

      const applied = yield* routes.deliver(
        signed({ type: "product.updated", data: { id: "prod_example" } }),
      );

      expect(applied).toEqual({ action: "ignored", eventId: null });
    }).pipe(Effect.provide(world)),
  );
});
