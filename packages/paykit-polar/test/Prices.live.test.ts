import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
import { encodeVendorPart } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { meterNameOf } from "../src/Meter.ts";
import { PolarBilling } from "../src/PolarBilling.ts";
import { POLAR_BASE_URL } from "../src/PolarClient.ts";
import { PolarPrices, productNameOf } from "../src/Prices.ts";
import { polarProviders } from "../src/Providers.ts";

/**
 * The engine half of `PolarPrices`, tested the way Alchemy tests a resource:
 * `test.provider` with a scratch stack, `stack.deploy` and `stack.destroy`, and
 * the sandbox verified out of band through distilled.
 *
 * It needs a real Polar sandbox token, so it is gated: without
 * `POLAR_ACCESS_TOKEN` the case is skipped, and CI stays green with no vendor
 * account. The token is always sent to the sandbox, never production. Run it
 * with a sandbox token:
 *
 * ```sh
 * POLAR_ACCESS_TOKEN=polar_sandbox_… pnpm --filter @potion.run/paykit-polar test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 *
 * **Every case owns its own tier and feature, and its own logical id.** The
 * harness names a scratch stack after the test's title and derives a stage from
 * the user, while Polar's identity for a product is `(stage, tier)` and for a
 * meter is `(stage, feature)` — so two cases that sold tier `pro` would ask one
 * sandbox for one object and the second would be refused `OwnedBySomeoneElse`,
 * correctly. Products and meters are `RemovalPolicy.retain`, so a case's object
 * outlives it and the collision would not clear between runs. Renaming a case
 * orphans what it created for the same reason: the stack name changes, the
 * vendor name does not.
 */
const accessToken = process.env.POLAR_ACCESS_TOKEN;
const hasToken = accessToken !== undefined && accessToken !== "";

const { test } = Test.make({
  providers: polarProviders({
    accessToken: Redacted.make(accessToken ?? ""),
    server: "sandbox",
  }),
});

/** Out-of-band reads, provided the way the vendor package provides them. */
const live = Layer.mergeAll(
  DistilledPolar.fromApiKey({
    apiKey: Redacted.make(accessToken ?? ""),
    apiBaseUrl: POLAR_BASE_URL.sandbox,
  }),
  DistilledPolar.PolarProtocol,
  FetchHttpClient.layer,
);

type VendorPrice = DistilledPolar.Product["prices"][number];

type FixedPrice = {
  readonly price_amount: number;
  readonly price_currency: string;
  readonly is_archived: boolean;
};

const isFixedPrice = (price: VendorPrice): price is VendorPrice & FixedPrice =>
  "price_amount" in price;

const fixedPriceOf = (product: DistilledPolar.Product): FixedPrice | undefined =>
  product.prices.filter(isFixedPrice).find((price) => !price.is_archived);

const byName = Effect.fn(function* (name: string) {
  const listed = yield* DistilledPolar.productsList({ limit: 100 });

  return listed.items
    .filter((product) => product.name === name)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .at(0);
});

const productNamed = (name: string) => byName(name).pipe(Effect.provide(live));

const readProduct = (id: string) => DistilledPolar.productsGet({ id }).pipe(Effect.provide(live));

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

/**
 * A unit amount the way Polar reports it: a decimal string at a fixed scale, so
 * `2` arrives as `"2.000000000000"`. Compared as a number, because the scale is
 * the vendor's and asserting it would pin an encoding paykit does not choose.
 */
const amountOf = (decimal: string): number => Number(decimal);

test.provider.skipIf(!hasToken)(
  "creates the product the catalog states, keeps its identity, and retains a replaced one",
  (stack) =>
    Effect.gen(function* () {
      // Start from nothing: a previous run's products must not be mistaken for
      // this run's.
      yield* stack.destroy();

      const first = yield* stack.deploy(PolarPrices("PricesBase", { tiers: { pro: proPrice } }));
      const productId = first.products.pro;
      const name = productNameOf(stack.stage, "pro");

      // The id is Polar's, so the test asserts it round-trips rather than
      // assuming an encoding.
      expect((yield* readProduct(productId)).id).toBe(productId);
      // The stage is encoded into the name, so a stage with a separator in it
      // cannot forge another identity. Assert the encoding, not the raw value.
      expect(name).toBe(`paykit:${encodeVendorPart(stack.stage)}:pro`);

      const created = yield* productNamed(name);
      expect(created?.id).toBe(productId);
      expect(created?.metadata.paykit_tier).toBe("pro");
      expect(created?.recurring_interval).toBe("month");
      const createdPrice = created === undefined ? undefined : fixedPriceOf(created);
      expect(createdPrice?.price_amount).toBe(1900);
      expect(createdPrice?.price_currency).toBe("usd");

      // Identity survives a lost state: a deploy with no state adopts the
      // product the metadata names instead of creating a second one.
      yield* stack.destroy();
      const adopted = yield* stack.deploy(PolarPrices("PricesBase", { tiers: { pro: proPrice } }));
      expect(adopted.products.pro).toBe(productId);

      // Polar embeds the price in the product, so a price change is a new
      // generation: a new id, the same tier identity, and the old one kept.
      const second = yield* stack.deploy(
        PolarPrices("PricesBase", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
      );

      expect(second.products.pro).not.toBe(productId);

      const replaced = yield* productNamed(name);
      expect(replaced?.id).toBe(second.products.pro);
      const replacedPrice = replaced === undefined ? undefined : fixedPriceOf(replaced);
      expect(replacedPrice?.price_amount).toBe(2400);

      const previous = yield* readProduct(productId);
      expect(previous.id).toBe(productId);
      expect(fixedPriceOf(previous)?.price_amount).toBe(1900);

      // A tier that leaves the catalog is retained the same way.
      yield* stack.deploy(PolarPrices("PricesBase", { tiers: {} }));
      const retired = yield* readProduct(productId);
      expect(retired.id).toBe(productId);
      const alsoRetired = yield* readProduct(second.products.pro);
      expect(alsoRetired.id).toBe(second.products.pro);
    }),
);

test.provider.skipIf(!hasToken)("creates a one-time product for a one-off pack", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const sold = yield* stack.deploy(
      PolarPrices("PricesOneOff", {
        tiers: { credits: { price: { ...proPrice, amount: 9_900 }, kind: "one_off" } },
      }),
    );

    const product = yield* readProduct(sold.products.credits);
    expect(product.is_recurring).toBe(false);
    expect(product.recurring_interval).toBe(null);
    expect(fixedPriceOf(product)?.price_amount).toBe(9_900);
  }),
);

test.provider.skipIf(!hasToken)(
  "creates a meter and a metered price from the catalog's unit price",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const sold = yield* stack.deploy(
        PolarPrices("PricesMeter", {
          tiers: {
            metered: {
              price: proPrice,
              usage: { requests: { amount: 2, currency: "usd" } },
            },
          },
        }),
      );

      const product = yield* readProduct(sold.products.metered);

      const metered = product.prices.find((price) => "meter_id" in price) as
        | {
            readonly meter_id: string;
            readonly unit_amount: string;
            readonly price_currency: string;
          }
        | undefined;

      expect(metered === undefined ? undefined : amountOf(metered.unit_amount)).toBe(2);
      expect(metered?.price_currency).toBe("usd");

      const listed = yield* DistilledPolar.metersList({ limit: 100 }).pipe(Effect.provide(live));

      const meter = listed.items.find(
        (candidate) => candidate.name === meterNameOf(stack.stage, "requests"),
      );

      expect(meter?.aggregation).toEqual({ func: "sum", property: "metadata.units" });
      expect(meter?.filter.clauses[0]).toMatchObject({
        property: "name",
        value: sold.meters.requests,
      });
      expect(meter?.metadata.paykit_feature).toBe("requests");
    }),
);

test.provider.skipIf(!hasToken)(
  "joins the products it creates into the provider in one call",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const billing = yield* stack.deploy(
        PolarBilling("BillingJoined", {
          accessToken: accessToken ?? "",
          server: "sandbox",
          origin: "https://app.example.com",
          tiers: { joined: proPrice },
        }),
      );

      const product = yield* readProduct(billing.sold.products.joined);
      expect(product.id).toBe(billing.sold.products.joined);
      expect(product.name).toBe(productNameOf(stack.stage, "joined"));
      expect(billing.prices).toEqual({ joined: proPrice });
      expect(billing.capabilities.has("checkout")).toBe(true);
    }),
);

test.provider.skipIf(!hasToken)(
  "creates a package price and a meter tier ladder, and keeps the replaced product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tiers = {
        package: {
          price: proPrice,
          usage: { units: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
        },
        ladder: {
          price: proPrice,
          usage: {
            units: {
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

      const sold = yield* stack.deploy(PolarPrices("PricesLadder", { tiers }));

      const packageProduct = yield* readProduct(sold.products.package);

      const packagePrice = packageProduct.prices.find((price) => "meter_id" in price) as
        | { readonly unit_amount: string }
        | undefined;

      expect(packagePrice === undefined ? undefined : amountOf(packagePrice.unit_amount)).toBe(0.5);

      const ladderProduct = yield* readProduct(sold.products.ladder);

      const ladderPrice = ladderProduct.prices.find((price) => "meter_id" in price) as
        | {
            readonly amount_type: string;
            readonly tiers: {
              readonly type: string;
              readonly tiers: ReadonlyArray<{
                readonly bound?: number | null;
                readonly unit_amount: string;
              }>;
            };
          }
        | undefined;

      expect(ladderPrice?.amount_type).toBe("metered_tiers");
      expect(ladderPrice?.tiers.type).toBe("graduated");
      expect(
        ladderPrice?.tiers.tiers.map((band) => ({
          bound: band.bound ?? null,
          unit_amount: amountOf(band.unit_amount),
        })),
      ).toEqual([
        { bound: 100, unit_amount: 1 },
        { bound: null, unit_amount: 2 },
      ]);

      const changed = yield* stack.deploy(
        PolarPrices("PricesLadder", {
          tiers: {
            ...tiers,
            ladder: {
              ...tiers.ladder,
              usage: {
                units: {
                  ...tiers.ladder.usage.units,
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

      expect(changed.products.ladder).not.toBe(sold.products.ladder);
      const previous = yield* readProduct(sold.products.ladder);
      expect(previous.id).toBe(sold.products.ladder);
    }),
);
