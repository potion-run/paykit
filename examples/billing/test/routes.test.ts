import { describe, expect, it } from "@alchemy.run/test";
import {
  Check,
  InsecureDevGuards,
  Paykit,
  Subscription,
  type MoneyProvider,
} from "@potion.run/paykit";
import { Polar, type PolarClient } from "@potion.run/paykit-polar";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { billing } from "../src/billing.config.ts";
import { moneyRoutes, Provider } from "../src/Billing.ts";

const account = "acct_routes";
const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const tiers = { pro: { price: proPrice, productId: "prod_example" } };

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
});

/** The provider a deployment swaps in: one call, and the routes come alive. */
const polar = (asked: Array<Record<string, unknown>> = []) =>
  Polar({
    accessToken: "polar_t",
    origin: "https://app.example.com",
    tiers,
    webhookSecret: Redacted.make(secret),
    client: recording(asked),
  });

const world = (provider: MoneyProvider) =>
  Paykit.world({ ...billing, providers: [provider], guards: InsecureDevGuards });

/** An independent HMAC over Polar's signed string, as a delivery would carry. */
const signed = (body: unknown): { headers: Record<string, string>; body: string } => {
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(performance.timeOrigin + performance.now()) / 1000);

  const tag = new Bun.CryptoHasher("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${"msg_example"}.${timestamp}.${payload}`)
    .digest("base64");

  return {
    headers: {
      "webhook-id": "msg_example",
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
    product_id: "prod_example",
    total_amount: 1900,
    currency: "usd",
    customer: { id: "cus_example", external_id: account },
    ...patch,
  },
});

describe("the example's money routes", () => {
  it.live("the manual provider answers a purchase with an invoice, not a checkout", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(Provider);
      const purchase = yield* routes.purchase(account, "pro");
      expect("invoiceId" in purchase).toBe(true);
      // And it has no webhook to verify, which the route turns into a 501.
      const error = yield* Effect.flip(routes.deliver({ headers: {}, body: "{}" }));
      expect(error._tag).toBe("ProviderCapabilityMissing");
    }).pipe(Effect.provide(world(Provider))),
  );

  it.live("a Polar purchase is a checkout, and the signed delivery activates it", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const routes = yield* moneyRoutes(polar(asked));

      // 1. The route asks the provider for a path to pay.
      const purchase = yield* routes.purchase(account, "pro");
      expect("url" in purchase).toBe(true);

      if ("url" in purchase) expect(purchase.url).toContain("prod_example");

      // 2. The provider says it was paid, signed with its own secret.
      const applied = yield* routes.deliver(signed(orderPaid()));
      expect(applied.action).toBe("activated");
      expect(applied.eventId).toBe("msg_example");

      // 3. The entitlement answers from local state, no provider in the read.
      const check = yield* Check(account);
      let answer = yield* check({ feature: "messages", amount: 1 });

      // A view is fed by deliveries, so the read catches up just after the
      // command commits.
      for (let attempt = 0; attempt < 500 && !answer.allowed; attempt++) {
        yield* Effect.sleep("10 millis");
        answer = yield* check({ feature: "messages", amount: 1 });
      }

      expect(answer.allowed).toBe(true);
      expect(answer.remaining).toBe(2_000);
    }).pipe(Effect.provide(world(polar()))),
  );

  it.live("a tampered delivery never reaches the model", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(polar());
      const delivery = signed(orderPaid());
      const tampered = { ...delivery, body: delivery.body.replace("1900", "1") };
      const error = yield* Effect.flip(routes.deliver(tampered));
      expect(error._tag).toBe("WebhookSignatureInvalid");

      // Nothing was recorded: the account is still unsubscribed.
      const subscription = yield* Subscription;
      const state = yield* subscription.state(Subscription.ref(account));
      expect(state._tag).toBe("Unsubscribed");
    }).pipe(Effect.provide(world(polar()))),
  );

  it.live("an event paykit does not model is acknowledged and ignored", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(polar());

      const applied = yield* routes.deliver(
        signed({ type: "product.updated", data: { id: "prod_example" } }),
      );

      expect(applied).toEqual({ action: "ignored", eventId: null });
    }).pipe(Effect.provide(world(polar()))),
  );

  it.live("a price with no tier mapping cannot activate, and names the field", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(polar());

      const error = yield* Effect.flip(
        routes.deliver(signed(orderPaid({ product_id: "prod_unknown" }))),
      );

      // The decoder refused to invent a tier; a paid order on an account with
      // no standing cannot activate without one. The route answers 400, which
      // is a support ticket rather than a silently free month.
      expect(error._tag).toBe("WebhookInvalid");

      if (error._tag === "WebhookInvalid") expect(error.field).toBe("tier");
    }).pipe(Effect.provide(world(polar()))),
  );
});
