import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import {
  Actor,
  MemoryBillingReadStore,
  Model as PaykitModel,
  PaykitHandlers,
  Subscription,
  allowance,
  allowancesOf,
  catalog,
  catalogLayer,
  messages,
  prorate,
  system,
  tier,
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
import { Polar, type PolarClient } from "../src/Polar.ts";
import { polarWebhook } from "../src/Webhooks.ts";
import { request, secret, tiers } from "./support/Webhook.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const scalePrice = { amount: 9900, currency: "usd", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price: proPrice,
  grants: [allowance(messages, { included: 2_000 })],
});

const scaleTier = tier({
  id: "scale",
  price: scalePrice,
  grants: [allowance(messages, { included: 9_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier, scaleTier] }));
const scale = allowancesOf(testCatalog, "scale")!;
const account = "acct_e2e";

/** A stand-in for Polar, recording what the package asked it to do. */
const polarClient = (asked: Array<Record<string, unknown>> = []): PolarClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: `https://polar.test/checkout/${request.productId}` };
    }),
  createCustomerSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: "https://polar.test/portal" };
    }),
  createInvoice: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { invoiceId: "ord_proration_1" };
    }),
  createRefund: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { refundId: "re_test" };
    }),
});

const world = (client: PolarClient) => {
  const polar = Polar({
    accessToken: "polar_t",
    origin: "https://app.example.com",
    tiers,
    invoiceProductId: "prod_proration",
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
      Layer.provide(polar.payments),
      Layer.provide(catalogLayer(testCatalog)),
    ),
    catalogLayer(testCatalog),
    polar.payments,
  );
};

const webhook = polarWebhook({ secret: Redacted.make(secret), tiers });

/** A delivery signed at the clock the model is reading. */
const delivery = Effect.gen(function* () {
  const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));

  return request({
    id: "msg_e2e",
    timestamp,
    body: {
      type: "order.paid",
      data: {
        id: "ord_e2e",
        status: "paid",
        product_id: "prod_123",
        total_amount: 1900,
        currency: "usd",
        customer: { id: "cus_e2e", external_id: account },
      },
    },
  });
});

/** Buy pro and let Polar's webhook activate it, as a deployment would. */
const purchased = Effect.gen(function* () {
  const subscribe = yield* Subscribe(account);
  yield* subscribe({ tier: "pro" });
  const event = Option.getOrThrow(yield* webhook(yield* delivery));
  yield* handleWebhook(event);
});

describe("Polar, from checkout to check()", () => {
  it.live("a purchase and its signed webhook are what moves the standing", () =>
    Effect.gen(function* () {
      yield* purchased;

      // The entitlement answers from local state, with no provider in the read.
      const check = yield* Check(account);
      let result = yield* check({ feature: "messages", amount: 1 });

      // A view is fed by deliveries, so the read catches up just after the
      // command commits. The budget is in seconds: a loaded suite is slower.
      for (let attempt = 0; attempt < 500 && !result.allowed; attempt++) {
        yield* Effect.sleep("10 millis");
        result = yield* check({ feature: "messages", amount: 1 });
      }

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2_000);
      expect(result.standing).toBe("good");
    }).pipe(Effect.provide(world(polarClient()))),
  );

  it.live("a redelivered webhook is a replay, not a second activation", () =>
    Effect.gen(function* () {
      const carried = yield* delivery;
      const first = Option.getOrThrow(yield* webhook(carried));
      yield* handleWebhook(first);
      const second = Option.getOrThrow(yield* webhook(carried));
      expect(second.id).toBe(first.id);
      expect(yield* handleWebhook(second)).toBe("ignored");
    }).pipe(Effect.provide(world(polarClient()))),
  );

  it.live("a tampered delivery never reaches the model", () =>
    Effect.gen(function* () {
      const carried = yield* delivery;
      const tampered = { ...carried, body: carried.body.replace("1900", "100") };
      const exit = yield* Effect.exit(webhook(tampered));
      expect(exit._tag).toBe("Failure");

      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("WebhookSignatureInvalid");
    }).pipe(Effect.provide(world(polarClient()))),
  );

  it.live("charges an upgrade's proration through a Polar one-off order", () => {
    const asked: Array<Record<string, unknown>> = [];

    return Effect.gen(function* () {
      yield* purchased;

      const subscription = yield* Subscription;
      const ref = Subscription.ref(account);
      const state = yield* subscription.state(ref);

      if (state._tag !== "Subscribed") return yield* Effect.die("expected a standing");

      // The same arithmetic the model will check the command against, at the
      // start of the period it is holding.
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
      expect(charged).toEqual({
        outcome: "charged",
        invoiceId: "ord_proration_1",
        amount: 8_000,
        currency: "usd",
      });
      // And the amount Polar was asked to bill is the amount the log recorded.
      expect(asked).toContainEqual(
        expect.objectContaining({
          customerExternalId: account,
          productId: "prod_proration",
          amount: 8_000,
          currency: "usd",
        }),
      );
    }).pipe(Effect.provide(world(polarClient(asked))));
  });
});
