import { describe, expect, it } from "@alchemy.run/test";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "@potion.run/paykit";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Polar, polarBindings, polarPriceOf, type PolarClient } from "../src/Polar.ts";

/** What the Polar SDK raises: tagged, so it never enters a failure channel as `unknown`. */
class PolarVendorFailure extends Data.TaggedError("PolarVendorFailure")<{
  readonly message: string;
}> {}

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const tiers = { pro: { price: proPrice, productId: "prod_123" } };

/** A stand-in for Polar, recording what the adapter asked for. */
const recording = (asked: Array<Record<string, unknown>>): PolarClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { url: "https://polar.sh/checkout/cs_1" };
    }),
  createCustomerSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { url: "https://polar.sh/portal/cs_1" };
    }),
  createRefund: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return {};
    }),
});

const runWith = <A, E, R>(provider: ReturnType<typeof Polar>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(provider.payments)) as Effect.Effect<A, E | PaymentDeclined, never>;

describe("Polar as a paykit provider", () => {
  it.effect("sells a tier through one checkout, with the product the catalog maps", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });

      const session = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
        }),
      );
      expect(session.url).toContain("polar.sh");
      expect(asked[0]).toMatchObject({
        productId: "prod_123",
        customerExternalId: "acct_1",
        successUrl: "https://app.example.com/welcome",
        returnUrl: "https://app.example.com/billing",
      });
    }),
  );

  it.effect("opens the customer portal through a customer session", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });
      const portal = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createPortal({ account: "acct_1" });
        }),
      );
      expect(portal.url).toContain("portal");
      expect(asked[0]).toMatchObject({ customerExternalId: "acct_1" });
    }),
  );

  it.effect("a vendor failure is a declined payment the model can record", () =>
    Effect.gen(function* () {
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        client: {
          ...recording([]),
          createCheckoutSession: () =>
            Effect.fail(new PolarVendorFailure({ message: "insufficient_funds" })),
        },
      });
      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
      if ((error as PaymentDeclined)._tag === "PaymentDeclined")
        expect((error as PaymentDeclined).message).toContain("insufficient_funds");
    }),
  );

  it.effect("a tier with no Polar product is refused, not guessed", () =>
    Effect.gen(function* () {
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        client: recording([]),
      });
      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
    }),
  );

  it("a merchant of record declares what it owns, and Stack sees the price", () => {
    const provider = Polar({
      accessToken: "polar_t",
      origin: "https://app.example.com",
      tiers,
      client: recording([]),
    });
    expect(provider.kind).toBe("merchant_of_record");
    expect(provider.capabilities.has("checkout")).toBe(true);
    // Polar owns tax and receipts; paykit still owns the entitlement.
    expect(provider.prices).toEqual({ pro: proPrice });
    expect(polarPriceOf({ tiers }, "pro")).toEqual(proPrice);
    expect(polarPriceOf({ tiers }, "scale")).toBe(null);
  });

  it("refuses to construct without a client, rather than start a checkout that cannot finish", () => {
    expect(() => Polar({ accessToken: "polar_t", origin: "https://app.example.com" })).toThrow();
  });

  it("maps the client to the port without the port knowing Polar", () => {
    const bindings = polarBindings(recording([]), { origin: "https://app.example.com" });
    expect(typeof bindings.createCheckoutSession).toBe("function");
    expect(typeof bindings.createCustomerSession).toBe("function");
  });

  it("declares no portal capability of its own beyond the session it has", () => {
    const provider = Polar({
      accessToken: "polar_t",
      origin: "https://app.example.com",
      tiers,
      client: recording([]),
    });
    // A capability this adapter does not implement must not be advertised.
    expect(provider.capabilities.has("invoice")).toBe(false);
    expect(ProviderCapabilityMissing).toBeDefined();
    expect(Layer.empty).toBeDefined();
  });
});
