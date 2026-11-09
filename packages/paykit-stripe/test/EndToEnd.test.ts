import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import {
  Actor,
  MemoryBillingReadStore,
  Model as PaykitModel,
  PaykitHandlers,
  Subscription,
  planItem,
  planItemsOf,
  catalog,
  catalogLayer,
  messages,
  prorate,
  system,
  plan,
  ChangeTierCommand,
} from "@potion.run/paykit";
// These suites drive the implementation modules the binding layers delegate to:
// the public surface names the tags (`Paykit.Webhook(account)`), and the vendor
// end-to-end path is about the provider, not about the binding shape.
import { BillingInProcess, Check, ChargeProration, Subscribe } from "@potion.run/paykit/Billing";
import { handleWebhook } from "@potion.run/paykit/Webhooks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Stripe, type StripeClient } from "../src/Stripe.ts";
import { stripeWebhook } from "../src/Webhooks.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const scalePrice = { amount: 9900, currency: "usd", interval: "month" as const };

const proTier = plan({
  id: "pro",
  price: proPrice,
  grants: [planItem(messages, { included: 2_000 })],
});

const scaleTier = plan({
  id: "scale",
  price: scalePrice,
  grants: [planItem(messages, { included: 9_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier, scaleTier] }));
const scale = planItemsOf(testCatalog, "scale")!;
const account = "acct_e2e";
const secret = "whsec_stripe_e2e";

/** A stand-in for Stripe, recording what the package asked it to do. */
const stripeClient = (asked: Array<Record<string, unknown>> = []): StripeClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: `https://checkout.stripe.test/${request.tier}` };
    }),
  createBillingPortalSession: () =>
    Effect.sync(() => ({ url: "https://billing.stripe.test/portal" })),
  createInvoice: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { invoiceId: "in_proration" };
    }),
  createRefund: () => Effect.sync(() => ({ refundId: "re_test" })),
});

const world = (client: StripeClient) => {
  const stripe = Stripe({
    secretKey: Redacted.make("sk_test_1"),
    origin: "https://app.example.com",
    tiers: {
      pro: { price: proPrice, priceId: "price_123" },
      scale: { price: scalePrice, priceId: "price_999" },
    },
    client,
  });

  const model = PaykitModel.layer(PaykitHandlers).pipe(
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provide(Domain.InMemory),
    Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  );

  return Layer.mergeAll(
    model,
    // The bindings resolve the model, the catalog and the provider when the
    // layer is built, so they are provided rather than merged beside it.
    BillingInProcess.pipe(
      Layer.provide(model),
      Layer.provide(stripe.payments),
      Layer.provide(catalogLayer(testCatalog)),
    ),
    catalogLayer(testCatalog),
    stripe.payments,
  );
};

const webhook = stripeWebhook({
  secret: Redacted.make(secret),
  tiers: { pro: { price: proPrice, priceId: "price_123" } },
});

/** Stripe's signed string is `"<timestamp>.<body>"`, hex, in the header. */
const sign = (body: string, timestamp: string): string =>
  `t=${timestamp},v1=${new Bun.CryptoHasher("sha256", new TextEncoder().encode(secret))
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

const delivery = Effect.gen(function* () {
  const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));

  const body = JSON.stringify({
    id: "evt_e2e",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_e2e",
        customer: account,
        client_reference_id: account,
        amount_total: 1900,
        currency: "usd",
        metadata: { tier: "pro" },
      },
    },
  });

  return {
    headers: { "stripe-signature": sign(body, timestamp) },
    body,
  };
});

/** Buy pro and let Stripe's webhook activate it, as a deployment would. */
const purchased = Effect.gen(function* () {
  const subscribe = yield* Subscribe(account);
  yield* subscribe({ tier: "pro" });
  const event = Option.getOrThrow(yield* webhook(yield* delivery));
  yield* handleWebhook(event);
});

describe("Stripe, from checkout to check()", () => {
  it.live("a purchase and its signed webhook are what moves the standing", () =>
    Effect.gen(function* () {
      yield* purchased;

      const check = yield* Check(account);
      let result = yield* check({ featureId: "messages", requiredBalance: 1 });

      // A view is fed by deliveries, so the read catches up just after the
      // command commits. The budget is in seconds: a loaded suite is slower.
      for (let attempt = 0; attempt < 500 && !result.allowed; attempt++) {
        yield* Effect.sleep("10 millis");
        result = yield* check({ featureId: "messages", requiredBalance: 1 });
      }

      expect(result.allowed).toBe(true);
      expect(result.balance.remaining).toBe(2_000);
      expect(result.standing).toBe("good");
    }).pipe(Effect.provide(world(stripeClient()))),
  );

  it.live("a redelivered webhook is a replay, not a second activation", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const carried = yield* delivery;
      const first = Option.getOrThrow(yield* webhook(carried));
      yield* handleWebhook(first);
      const before = yield* subscription.state(Subscription.ref(account));
      const second = Option.getOrThrow(yield* webhook(carried));
      expect(second.id).toBe(first.id);
      yield* handleWebhook(second);
      // The event id is the command id, so the replay records nothing: the
      // standing is byte for byte what it was.
      expect(yield* subscription.state(Subscription.ref(account))).toEqual(before);
    }).pipe(Effect.provide(world(stripeClient()))),
  );

  it.live("charges an upgrade's proration as one Stripe invoice", () => {
    const asked: Array<Record<string, unknown>> = [];

    return Effect.gen(function* () {
      yield* purchased;

      const subscription = yield* Subscription;
      const ref = Subscription.ref(account);
      const state = yield* subscription.state(ref);

      if (state._tag !== "Subscribed") return yield* Effect.die("expected a standing");

      const proration =
        prorate({
          from: proPrice,
          to: scalePrice,
          period: { start: state.period.start, end: state.period.end },
          at: state.period.start,
        }) ?? undefined;

      yield* subscription.send(
        ref,
        new ChangeTierCommand({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "scale",
          allowances: scale,
          price: scalePrice,
          proration,
        }),
      );

      const charged = yield* (yield* ChargeProration(account))();
      expect(charged).toMatchObject({ outcome: "charged", amount: 8_000, currency: "usd" });
      expect(asked).toContainEqual(
        expect.objectContaining({ customerExternalId: account, amount: 8_000, currency: "usd" }),
      );
    }).pipe(Effect.provide(world(stripeClient(asked))));
  });

  it.live("a tampered delivery never reaches the model", () =>
    Effect.gen(function* () {
      const carried = yield* delivery;
      const tampered = { ...carried, body: carried.body.replace("1900", "100") };
      const exit = yield* Effect.exit(webhook(tampered));
      expect(exit._tag).toBe("Failure");

      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("WebhookSignatureInvalid");
    }).pipe(Effect.provide(world(stripeClient()))),
  );
});
