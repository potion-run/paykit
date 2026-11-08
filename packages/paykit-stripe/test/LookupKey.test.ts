import { describe, expect, it } from "@alchemy.run/test";
import { PaymentDeclined, Payments } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Stripe, type StripeClient } from "../src/Stripe.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

const client = (asked: Array<Record<string, unknown>> = []): StripeClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: `https://checkout.stripe.test/${request.priceIds.join(",")}` };
    }),
  createBillingPortalSession: () => Effect.succeed({ url: "https://billing.stripe.test/portal" }),
  createInvoice: () => Effect.succeed({ invoiceId: "in_proration" }),
  createRefund: () => Effect.succeed({ refundId: "re_test" }),
  resolvePrice: (lookupKey) =>
    Effect.succeed(lookupKey === "paykit:pro" ? "price_resolved" : "price_other"),
});

const runWith = <A, E, R>(provider: ReturnType<typeof Stripe>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(provider.payments)) as Effect.Effect<A, E | PaymentDeclined, never>;

describe("selling a tier by lookup key", () => {
  it.effect("resolves the key to the price that answers for the tier now", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];

      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers: { pro: { price: proPrice, lookupKey: "paykit:pro" } },
        client: client(asked),
      });

      const checkout = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
        }),
      );

      // The id came from the resolver, not from config: a replaced price needs
      // no config change.
      expect(checkout.url).toContain("price_resolved");
      expect(asked[0]).toMatchObject({ priceIds: ["price_resolved"], tier: "pro" });
    }),
  );

  it.effect("still prefers an explicit priceId when one is configured", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];

      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers: { pro: { price: proPrice, priceId: "price_pinned", lookupKey: "paykit:pro" } },
        client: client(asked),
      });

      const checkout = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
        }),
      );

      expect(checkout.url).toContain("price_pinned");
    }),
  );

  it.effect("refuses a key when the client cannot resolve one, rather than guessing", () =>
    Effect.gen(function* () {
      const partial: StripeClient = {
        createCheckoutSession: client().createCheckoutSession,
        createBillingPortalSession: client().createBillingPortalSession,
        createInvoice: client().createInvoice,
      };

      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers: { pro: { price: proPrice, lookupKey: "paykit:pro" } },
        client: partial,
      });

      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({
              account: "acct_1",
              tier: "pro",
              kind: "subscription",
            });
          }),
        ),
      );

      expect(error).toBeInstanceOf(PaymentDeclined);

      if (error._tag === "PaymentDeclined") expect(error.code).toBe("price_not_configured");
    }),
  );
});
