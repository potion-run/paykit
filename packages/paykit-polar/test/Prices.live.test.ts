import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
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

test.provider.skipIf(!hasToken)(
  "creates the product the catalog states, keeps its identity, and retains a replaced one",
  (stack) =>
    Effect.gen(function* () {
      // Start from nothing: a previous run's products must not be mistaken for
      // this run's.
      yield* stack.destroy();

      const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
      const productId = first.products.pro;
      const name = productNameOf(stack.stage, "pro");

      expect(productId.startsWith("prod_")).toBe(true);
      expect(name).toBe(`paykit:${stack.stage}:pro`);

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
      const adopted = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
      expect(adopted.products.pro).toBe(productId);

      // Polar embeds the price in the product, so a price change is a new
      // generation: a new id, the same tier identity, and the old one kept.
      const second = yield* stack.deploy(
        PolarPrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
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
      yield* stack.deploy(PolarPrices("Prices", { tiers: {} }));
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
      PolarPrices("Prices", {
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
        PolarPrices("Prices", {
          tiers: {
            pro: {
              price: proPrice,
              usage: { messages: { amount: 2, currency: "usd" } },
            },
          },
        }),
      );

      const product = yield* readProduct(sold.products.pro);

      const metered = product.prices.find((price) => "meter_id" in price) as
        | {
            readonly meter_id: string;
            readonly unit_amount: string;
            readonly price_currency: string;
          }
        | undefined;

      expect(metered?.unit_amount).toBe("2");
      expect(metered?.price_currency).toBe("usd");

      const listed = yield* DistilledPolar.metersList({ limit: 100 }).pipe(Effect.provide(live));

      const meter = listed.items.find(
        (candidate) => candidate.name === meterNameOf(stack.stage, "messages"),
      );

      expect(meter?.aggregation).toEqual({ func: "sum", property: "metadata.units" });
      expect(meter?.filter.clauses[0]).toMatchObject({
        property: "name",
        value: sold.meters.messages,
      });
      expect(meter?.metadata.paykit_feature).toBe("messages");
    }),
);

test.provider.skipIf(!hasToken)(
  "joins the products it creates into the provider in one call",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const billing = yield* stack.deploy(
        PolarBilling("Billing", {
          accessToken: accessToken ?? "",
          server: "sandbox",
          origin: "https://app.example.com",
          tiers: { pro: proPrice },
        }),
      );

      const product = yield* readProduct(billing.sold.products.pro);
      expect(product.id).toBe(billing.sold.products.pro);
      expect(product.name).toBe(productNameOf(stack.stage, "pro"));
      expect(billing.prices).toEqual({ pro: proPrice });
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

      const sold = yield* stack.deploy(PolarPrices("Prices", { tiers }));

      const packageProduct = yield* readProduct(sold.products.package);

      const packagePrice = packageProduct.prices.find((price) => "meter_id" in price) as
        | { readonly unit_amount: string }
        | undefined;

      expect(packagePrice?.unit_amount).toBe("0.5");

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
      expect(ladderPrice?.tiers.tiers).toEqual([
        { bound: 100, unit_amount: "1" },
        { bound: null, unit_amount: "2" },
      ]);

      const changed = yield* stack.deploy(
        PolarPrices("Prices", {
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

      expect(changed.products.ladder).not.toBe(sold.products.ladder);
      const previous = yield* readProduct(sold.products.ladder);
      expect(previous.id).toBe(sold.products.ladder);
    }),
);
