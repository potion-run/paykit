import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { GetBillingMeter, GetPrice, GetPrices, GetProduct } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { registerMeteredPriceProvider } from "../src/MeteredPrice.ts";
import { StripePrices } from "../src/Prices.ts";
import { StripeBilling } from "../src/StripeBilling.ts";
import { live, stripeLiveKey } from "./support/Live.ts";

/**
 * The engine half of `StripePrices`, tested the way Alchemy tests a resource:
 * `test.provider` with a scratch stack, `stack.deploy` and `stack.destroy`, and
 * the cloud state verified out of band through distilled — the vendor's own
 * fields, never the provider's returned attributes.
 *
 * It needs a real Stripe key, so it is gated: without `STRIPE_API_KEY` the case
 * is skipped, and CI stays green with no vendor account. The key must be
 * test-mode (`sk_test_`/`rk_test_`); a live key fails the file rather than
 * running, because Stripe's test mode is a property of the key and this suite
 * creates prices and meters. Run it with a test-mode key:
 *
 * ```sh
 * STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not reach:
 * a skip gate runs before any Effect exists.
 */
const apiKey = stripeLiveKey(process.env.STRIPE_API_KEY);
const hasKey = apiKey !== undefined;

// `Stripe.providers()` cannot enumerate a provider from this package, so put it
// into the collection while that layer is built. This is the layer cleanup
// builds too: registering from inside a reconcile is too late for a failed
// case's teardown, which then cannot delete (or orphan) its state rows.
const providers = Layer.effectDiscard(registerMeteredPriceProvider).pipe(
  Layer.provideMerge(Stripe.providers()),
);

const { test } = Test.make({ providers });

const productIdOf = (product: { readonly id: string } | string): string =>
  typeof product === "string" ? product : product.id;

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

test.provider.skipIf(!hasKey)(
  "creates the price the catalog states, replaces it on a change, and keeps the old one",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;

      // Clear this test's state. The provider's objects are retained by design,
      // so a previous run's price is adopted by its metadata, not mistaken for
      // this run's.
      yield* stack.destroy();

      const first = yield* stack.deploy(StripePrices("Prices", { tiers: { pro: proPrice } }));
      const lookupKey = first.prices.pro;

      // The key is the stage and the tier, not the id.
      expect(lookupKey.startsWith("paykit:")).toBe(true);
      expect(lookupKey.endsWith(":pro")).toBe(true);

      const created = yield* GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(created.data.length).toBe(1);
      const createdPrice = created.data[0]!;
      expect(createdPrice.unit_amount).toBe(1900);
      expect(createdPrice.currency).toBe("usd");
      expect(createdPrice.recurring?.interval).toBe("month");
      expect(createdPrice.lookup_key).toBe(lookupKey);
      expect(createdPrice.livemode).toBe(false);

      // The product is ours, and the tier is the metadata a restore finds it
      // by. Without this, a deploy that silently created a second product named
      // `pro` would still pass every price assertion.
      const createdProduct = yield* GetProduct({ id: productIdOf(createdPrice.product) }).pipe(
        Effect.provide(live(key)),
      );

      expect(createdProduct.name).toBe("pro");
      expect(createdProduct.metadata.paykit_tier).toBe("pro");

      // A changed amount is a replacement: Stripe prices are create-only, so a
      // new price answers for the same lookup key.
      const second = yield* stack.deploy(
        StripePrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
      );

      expect(second.prices.pro).toBe(lookupKey);

      const replaced = yield* GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(replaced.data.length).toBe(1);
      const replacedPrice = replaced.data[0]!;
      expect(replacedPrice.unit_amount).toBe(2400);
      expect(replacedPrice.id).not.toBe(createdPrice.id);
      expect(replacedPrice.lookup_key).toBe(lookupKey);

      // The old price is retained: not deleted, and still readable, because an
      // invoice may reference it. Retention is not archival, so it stays
      // active; the replacement took the one lookup key Stripe allows per price.
      const previous = yield* GetPrice({ price: createdPrice.id }).pipe(Effect.provide(live(key)));

      expect(previous.id).toBe(createdPrice.id);
      expect(previous.active).toBe(true);
      expect(previous.lookup_key).toBe(null);

      // A tier that leaves the catalog is retained the same way. The price the
      // catalog dropped is the one that still carries the key, and the sweep
      // (`RetiredPrices`) is a separate write; this deploy does not archive it.
      yield* stack.deploy(StripePrices("Prices", { tiers: {} }));

      const retiredCurrent = yield* GetPrice({ price: replacedPrice.id }).pipe(
        Effect.provide(live(key)),
      );

      expect(retiredCurrent.id).toBe(replacedPrice.id);
      expect(retiredCurrent.active).toBe(true);
      expect(retiredCurrent.lookup_key).toBe(lookupKey);

      const retiredPrevious = yield* GetPrice({ price: createdPrice.id }).pipe(
        Effect.provide(live(key)),
      );

      expect(retiredPrevious.active).toBe(true);
    }),
);

const packPrice = { amount: 9_900, currency: "usd", interval: "month" as const };

test.provider.skipIf(!hasKey)("creates a one-time price for a one-off pack", (stack) =>
  Effect.gen(function* () {
    const key = apiKey!;
    yield* stack.destroy();

    const sold = yield* stack.deploy(
      StripePrices("Prices", {
        tiers: { credits: { price: packPrice, kind: "one_off" } },
      }),
    );

    const creditKey = sold.prices.credits;

    const created = yield* GetPrices({
      lookup_keys: [creditKey],
      active: true,
      limit: 1,
    }).pipe(Effect.provide(live(key)));

    const price = created.data[0]!;
    expect(price.unit_amount).toBe(9_900);
    // A pack is charged once; a recurring price would make `mode=payment`
    // unusable and would start a subscription instead.
    expect(price.recurring).toBe(null);
  }),
);

test.provider.skipIf(!hasKey)(
  "creates a meter and a metered price from the catalog's unit price",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const sold = yield* stack.deploy(
        StripePrices("Prices", {
          tiers: {
            pro: {
              price: proPrice,
              usage: { messages: { amount: 2, currency: "usd" } },
            },
          },
        }),
      );

      const meteredKey = sold.usage.pro.messages;

      const created = yield* GetPrices({
        lookup_keys: [meteredKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      const price = created.data[0]!;
      expect(price.unit_amount).toBe(2);
      expect(price.currency).toBe("usd");
      expect(price.recurring?.usage_type).toBe("metered");
      expect(price.recurring?.meter).toBeDefined();
      expect(price.livemode).toBe(false);

      // The meter the price reports is the one the catalog's feature created,
      // configured the way `Stripe({ meters })` will report usage to it. A
      // returned event-name string alone would not prove the meter exists.
      const meter = yield* GetBillingMeter({ id: price.recurring!.meter! }).pipe(
        Effect.provide(live(key)),
      );

      expect(meter.livemode).toBe(false);
      expect(meter.event_name).toBe(sold.meters.messages);
      expect(meter.display_name).toBe(sold.meters.messages);
      expect(meter.status).toBe("active");
      expect(meter.default_aggregation).toEqual({ formula: "sum" });
      expect(meter.customer_mapping).toEqual({
        type: "by_id",
        event_payload_key: "stripe_customer_id",
      });
      expect(meter.value_settings).toEqual({ event_payload_key: "value" });

      const product = yield* GetProduct({ id: productIdOf(price.product) }).pipe(
        Effect.provide(live(key)),
      );

      expect(product.name).toBe("pro");
      expect(product.metadata.paykit_tier).toBe("pro");
    }),
);

test.provider.skipIf(!hasKey)(
  "creates a package transform and a tiered price, and keeps the replaced ladder",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const tiers = {
        package: {
          price: proPrice,
          usage: { messages: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
        },
        ladder: {
          price: proPrice,
          usage: {
            messages: {
              kind: "graduated",
              currency: "usd",
              bands: [
                { upTo: 100, amount: 1, currency: "usd" },
                { upTo: "inf", amount: 2, currency: "usd" },
              ],
            },
          },
        },
      } as const;

      const sold = yield* stack.deploy(StripePrices("Prices", { tiers }));

      // The list endpoint answers the lookup key; retrieve that id with the
      // tiers expanded. Stripe omits a tiered price's tiers unless asked.
      const priceOf = (lookupKey: string) =>
        GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
          Effect.provide(live(key)),
          Effect.flatMap((prices) => {
            const found = prices.data[0];

            return found === undefined
              ? Effect.succeed(undefined)
              : GetPrice({ price: found.id, expand: ["tiers"] }).pipe(Effect.provide(live(key)));
          }),
        );

      const packagePrice = yield* priceOf(sold.usage.package.messages);
      // `per_unit` is Stripe's default and is not what makes this a package;
      // the transform is. Assert the fields that carry the catalog's decision.
      expect(packagePrice?.unit_amount).toBe(500);
      expect(packagePrice?.transform_quantity).toEqual({ divide_by: 1_000, round: "up" });

      const ladderPrice = yield* priceOf(sold.usage.ladder.messages);
      expect(ladderPrice?.billing_scheme).toBe("tiered");
      expect(ladderPrice?.tiers_mode).toBe("graduated");
      expect(
        ladderPrice?.tiers?.map((tier) => ({ upTo: tier.up_to, amount: tier.unit_amount })),
      ).toEqual([
        { upTo: 100, amount: 1 },
        { upTo: null, amount: 2 },
      ]);

      const changed = yield* stack.deploy(
        StripePrices("Prices", {
          tiers: {
            ...tiers,
            ladder: {
              ...tiers.ladder,
              usage: {
                messages: {
                  ...tiers.ladder.usage.messages,
                  bands: [
                    { upTo: 100, amount: 1, currency: "usd" },
                    { upTo: "inf", amount: 3, currency: "usd" },
                  ],
                },
              },
            },
          },
        }),
      );

      const replaced = yield* priceOf(changed.usage.ladder.messages);
      expect(replaced?.id).not.toBe(ladderPrice?.id);

      // A replaced metered price is retained the same way a base price is:
      // active, still readable, and no longer carrying the key.
      const previous = yield* GetPrice({ price: ladderPrice!.id! }).pipe(Effect.provide(live(key)));

      expect(previous.id).toBe(ladderPrice?.id);
      expect(previous.active).toBe(true);
      expect(previous.lookup_key).toBe(null);
    }),
);

test.provider.skipIf(!hasKey)("creates a per-seat price on the tier's product", (stack) =>
  Effect.gen(function* () {
    const key = apiKey!;
    yield* stack.destroy();

    const seatPrice = { amount: 1_500, currency: "usd" };

    const sold = yield* stack.deploy(
      StripePrices("PricesSeat", {
        tiers: { seated: { price: proPrice, seats: { seats: seatPrice } } },
      }),
    );

    const seatKey = sold.seats.seated.seats;

    // The seat price is its own price, keyed per tier and feature, so a
    // subscription can add a line for it with a quantity.
    expect(seatKey).not.toBe(sold.prices.seated);
    expect(seatKey.endsWith(":seat:seats")).toBe(true);

    const created = yield* GetPrices({
      lookup_keys: [seatKey],
      active: true,
      limit: 1,
    }).pipe(Effect.provide(live(key)));

    expect(created.data.length).toBe(1);
    const price = created.data[0]!;
    expect(price.unit_amount).toBe(1_500);
    expect(price.currency).toBe("usd");
    expect(price.type).toBe("recurring");
    expect(price.recurring?.interval).toBe("month");
    // A seat is a licensed quantity, not usage: `usage_type` is what makes
    // Stripe bill the item's quantity rather than a meter.
    expect(price.recurring?.usage_type).toBe("licensed");
    expect(price.recurring?.meter).toBe(null);

    // Both prices sit on the tier's one product, so checkout adds both lines
    // to one subscription.
    const base = yield* GetPrices({
      lookup_keys: [sold.prices.seated],
      active: true,
      limit: 1,
    }).pipe(Effect.provide(live(key)));

    expect(productIdOf(price.product)).toBe(productIdOf(base.data[0]!.product));
  }),
);

test.provider.skipIf(!hasKey)(
  "adopts its price after state is lost instead of creating a second one",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        StripePrices("PricesAdopt", { tiers: { adopted: proPrice } }),
      );

      const lookupKey = first.prices.adopted;

      const before = yield* GetPrices({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(before.data.length).toBe(1);
      const priceId = before.data[0]!.id;

      // `destroy` drops state and retains the vendor object, which is how a
      // restored deployment starts. The metadata is the identity, so the next
      // deploy must find the same price instead of creating a duplicate.
      yield* stack.destroy();

      const again = yield* stack.deploy(
        StripePrices("PricesAdopt", { tiers: { adopted: proPrice } }),
      );

      expect(again.prices.adopted).toBe(lookupKey);

      const after = yield* GetPrices({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(after.data.length).toBe(1);
      expect(after.data[0]?.id).toBe(priceId);
    }),
);

test.provider.skipIf(!hasKey)(
  "joins the prices it creates into the provider in one call",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const billing = yield* stack.deploy(
        StripeBilling("BillingJoined", {
          secretKey: Redacted.make(key),
          origin: "https://app.example.com",
          tiers: {
            joined: {
              price: proPrice,
              usage: { messages: { amount: 2, currency: "usd" } },
            },
          },
          // A supplied secret means a hand-managed endpoint. This case is the
          // price join, and the deploy would otherwise create an endpoint at a
          // URL this suite does not serve; the endpoint has its own cases.
          webhookSecret: Redacted.make("whsec_joined_endpoint_is_managed_by_hand"),
        }),
      );

      expect(billing.kind).toBe("processor");
      expect(billing.capabilities.has("checkout")).toBe(true);
      // The metered price and the meter event name are what `reportUsage`
      // needs, so a joined deployment declares the usage capability too.
      expect(billing.capabilities.has("usage")).toBe(true);
      expect(billing.prices).toEqual({ joined: proPrice });

      const base = yield* GetPrices({
        lookup_keys: [billing.sold.prices.joined],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(base.data[0]?.unit_amount).toBe(1_900);

      const metered = yield* GetPrices({
        lookup_keys: [billing.sold.usage.joined.messages],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(metered.data[0]?.unit_amount).toBe(2);
      expect(metered.data[0]?.recurring?.usage_type).toBe("metered");
    }),
);
