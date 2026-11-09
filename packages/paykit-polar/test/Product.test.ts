import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MeterProvider } from "../src/Meter.ts";
import type { PolarClient } from "../src/Polar.ts";
import { PolarBilling } from "../src/PolarBilling.ts";
import { PolarPrices } from "../src/Prices.ts";
import { ProductProvider } from "../src/Product.ts";

/**
 * `PolarPrices` against a stand-in for Polar's products API.
 *
 * The live case in `Prices.live.test.ts` is the proof the real API accepts the
 * payload; this one proves the resource's three rules without an account: one
 * product per tier, the newest generation adopted after a lost state, and a
 * price change leaving the old product in place. Requests go through the real
 * protocol and schemas; only the HTTP transport is a fake.
 */

/** A metadata property the way Polar reports it: bare, without `metadata.`. */
const readBackAggregation = (
  aggregation: DistilledPolar.MeterAggregation,
): DistilledPolar.MeterAggregation =>
  "property" in aggregation
    ? { ...aggregation, property: aggregation.property.replace(/^metadata\./, "") }
    : aggregation;

interface FakeCreateBody {
  readonly name: string;
  readonly description?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly recurring_interval?: string;
  readonly prices?: ReadonlyArray<{
    readonly amount_type?: string;
    readonly price_amount?: number;
    readonly price_currency?: string;
    readonly meter_id?: string;
    readonly unit_amount?: number | string;
    readonly tiers?: {
      readonly type: "graduated" | "volume";
      readonly tiers: Array<{
        readonly bound?: number | null;
        readonly unit_amount: number | string;
      }>;
    };
  }>;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body;

  if (body._tag !== "Uint8Array") return undefined;

  return JSON.parse(new TextDecoder().decode(body.body));
};

const vendorProduct = (input: {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly amount: number;
  readonly currency: string;
  readonly interval: "month" | "year" | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly metered?: ReadonlyArray<{
    readonly meterId: string;
    readonly amount: number;
    readonly currency: string;
    readonly tiers?: {
      readonly type: "graduated" | "volume";
      readonly tiers: Array<{
        readonly bound?: number | null;
        readonly unit_amount: number | string;
      }>;
    };
  }>;
}): DistilledPolar.Product => ({
  id: input.id,
  created_at: input.createdAt,
  modified_at: null,
  trial_interval: null,
  trial_interval_count: null,
  name: input.name,
  description: input.description,
  visibility: "private",
  recurring_interval: input.interval,
  recurring_interval_count: input.interval === null ? null : 1,
  meter_interval: null,
  meter_interval_count: null,
  is_recurring: input.interval !== null,
  is_archived: input.archived,
  organization_id: "org_fake",
  metadata: input.metadata as DistilledPolar.MetadataOutputType,
  is_deletable: true,
  prices: [
    {
      id: `${input.id}_price`,
      created_at: input.createdAt,
      modified_at: null,
      source: "catalog",
      amount_type: "fixed",
      price_currency: input.currency,
      tax_behavior: null,
      is_archived: false,
      product_id: input.id,
      price_amount: input.amount,
    },
    ...(input.metered ?? []).map((metered, index) => {
      const meter = {
        id: metered.meterId,
        name: metered.meterId,
        unit: "scalar" as const,
        custom_label: null,
        custom_multiplier: null,
      };

      const base = {
        id: `${input.id}_metered_${index}`,
        created_at: input.createdAt,
        modified_at: null,
        source: "catalog" as const,
        price_currency: metered.currency,
        tax_behavior: null,
        is_archived: false,
        product_id: input.id,
        cap_amount: null,
        meter_id: metered.meterId,
        meter,
      };

      return metered.tiers === undefined
        ? { ...base, amount_type: "metered_unit", unit_amount: String(metered.amount) }
        : {
            ...base,
            amount_type: "metered_tiers",
            tiers: {
              ...metered.tiers,
              tiers: metered.tiers.tiers.map((tier) => ({
                ...(tier.bound === undefined ? {} : { bound: tier.bound }),
                unit_amount: String(tier.unit_amount),
              })),
            },
          };
    }),
  ],
  benefits: [],
  medias: [],
  attached_custom_fields: [],
});

const fakePolar = () => {
  const products = new Map<string, DistilledPolar.Product>();
  const meters = new Map<string, DistilledPolar.Meter>();
  const calls: Array<string> = [];
  let created = 0;
  let meterCreated = 0;

  const json = (
    request: HttpClientRequest.HttpClientRequest,
    status: number,
    body: unknown,
  ): HttpClientResponse.HttpClientResponse =>
    HttpClientResponse.fromWeb(request, Response.json(body, { status }));

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        const meterId = url.pathname.match(/^\/v1\/meters\/([^/]+)$/)?.[1];
        const isMeterCollection = url.pathname === "/v1/meters/" || url.pathname === "/v1/meters";

        if (isMeterCollection && request.method === "POST") {
          const body = bodyOf(request) as {
            readonly name: string;
            readonly unit?: string;
            readonly filter: DistilledPolar.Filter;
            readonly aggregation: DistilledPolar.MeterAggregation;
            readonly metadata?: Readonly<Record<string, unknown>>;
          };

          const id = `mtr_${++meterCreated}`;

          const meter: DistilledPolar.Meter = {
            id,
            created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, meterCreated)).toISOString(),
            modified_at: null,
            name: body.name,
            unit: (body.unit ?? "scalar") as DistilledPolar.MeterUnit,
            custom_label: null,
            custom_multiplier: null,
            filter: body.filter,
            // Polar accepts `metadata.units` and reports `units`: a stand-in that
            // echoed the request would hide a reconcile that never converges.
            aggregation: readBackAggregation(body.aggregation),
            organization_id: "org_fake",
            metadata: (body.metadata ?? {}) as DistilledPolar.MetadataOutputType,
            archived_at: null,
          };

          meters.set(id, meter);

          return Effect.succeed(json(request, 201, meter));
        }

        if (isMeterCollection && request.method === "GET") {
          const matches = [...meters.values()].filter((meter) => meter.archived_at == null);

          return Effect.succeed(
            json(request, 200, {
              items: matches,
              pagination: { total_count: matches.length, max_page: 1 },
            }),
          );
        }

        if (meterId !== undefined && request.method === "GET") {
          const meter = meters.get(meterId);

          return Effect.succeed(
            meter === undefined
              ? json(request, 404, { detail: "Not found" })
              : json(request, 200, meter),
          );
        }

        if (meterId !== undefined && request.method === "PATCH") {
          const current = meters.get(meterId);

          if (current === undefined) {
            return Effect.succeed(json(request, 404, { detail: "Not found" }));
          }

          const body = bodyOf(request) as {
            readonly name?: string | null;
            readonly filter?: DistilledPolar.Filter | null;
            readonly aggregation?: DistilledPolar.MeterAggregation | null;
            readonly metadata?: Readonly<Record<string, unknown>>;
            readonly is_archived?: boolean | null;
          };

          const updated: DistilledPolar.Meter = {
            ...current,
            ...(body.name == null ? {} : { name: body.name }),
            ...(body.filter == null ? {} : { filter: body.filter }),
            ...(body.aggregation == null
              ? {}
              : { aggregation: readBackAggregation(body.aggregation) }),
            ...(body.metadata === undefined
              ? {}
              : { metadata: body.metadata as DistilledPolar.MetadataOutputType }),
            ...(body.is_archived == null
              ? {}
              : { archived_at: body.is_archived ? new Date().toISOString() : null }),
          };

          meters.set(updated.id, updated);

          return Effect.succeed(json(request, 200, updated));
        }

        const id = url.pathname.match(/^\/v1\/products\/([^/]+)$/)?.[1];
        const isCollection = url.pathname === "/v1/products/" || url.pathname === "/v1/products";

        if (request.method === "POST" && isCollection) {
          const body = bodyOf(request) as FakeCreateBody;
          const price = body.prices?.find((candidate) => candidate.amount_type === "fixed");

          const metered = (body.prices ?? [])
            .filter(
              (candidate) =>
                candidate.amount_type === "metered_unit" ||
                candidate.amount_type === "metered_tiers",
            )
            .map((candidate) => ({
              meterId: candidate.meter_id ?? "",
              amount: Number(candidate.unit_amount ?? 0),
              currency: candidate.price_currency ?? "usd",
              ...(candidate.tiers === undefined ? {} : { tiers: candidate.tiers }),
            }));

          const productId = `prod_${++created}`;

          const product = vendorProduct({
            id: productId,
            name: body.name,
            description: body.description ?? null,
            metadata: body.metadata ?? {},
            amount: price?.price_amount ?? 0,
            currency: price?.price_currency ?? "usd",
            interval:
              body.recurring_interval === undefined
                ? null
                : body.recurring_interval === "year"
                  ? "year"
                  : "month",
            archived: false,
            createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, created)).toISOString(),
            metered,
          });

          products.set(productId, product);

          return Effect.succeed(json(request, 201, product));
        }

        if (request.method === "GET" && id !== undefined) {
          const product = products.get(id);

          return Effect.succeed(
            product === undefined
              ? json(request, 404, { detail: "Not found" })
              : json(request, 200, product),
          );
        }

        if (request.method === "GET" && isCollection) {
          const query = url.searchParams.get("query");

          const matches = [...products.values()]
            .filter((product) => query === null || product.name.includes(query))
            .sort((left, right) => right.created_at.localeCompare(left.created_at));

          return Effect.succeed(
            json(request, 200, {
              items: matches,
              pagination: { total_count: matches.length, max_page: 1 },
            }),
          );
        }

        if (request.method === "PATCH" && id !== undefined) {
          const current = products.get(id);

          if (current === undefined) {
            return Effect.succeed(json(request, 404, { detail: "Not found" }));
          }

          const request_ = bodyOf(request) as {
            readonly name?: string | null;
            readonly description?: string | null;
            readonly metadata?: Readonly<Record<string, unknown>>;
          };

          const updated: DistilledPolar.Product = {
            ...current,
            ...(request_.name == null ? {} : { name: request_.name }),
            ...(request_.description === undefined ? {} : { description: request_.description }),
            ...(request_.metadata === undefined
              ? {}
              : { metadata: request_.metadata as DistilledPolar.MetadataOutputType }),
          };

          products.set(updated.id, updated);

          return Effect.succeed(json(request, 200, updated));
        }

        return Effect.die(`the fake Polar does not implement ${request.method} ${url.pathname}`);
      }),
    ),
  );

  const reset = () => {
    products.clear();
    meters.clear();
    calls.length = 0;
    created = 0;
    meterCreated = 0;
  };

  return { layer, products, meters, calls, reset };
};

const polar = fakePolar();

const { test } = Test.make({
  providers: Layer.mergeAll(ProductProvider(), MeterProvider()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DistilledPolar.PolarProtocol,
        polar.layer,
        Layer.succeed(
          DistilledPolar.Credentials,
          Effect.succeed({
            apiKey: Redacted.make("polar_fake"),
            apiBaseUrl: "https://sandbox.example",
          }),
        ),
      ),
    ),
  ),
});

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

/** The checkout path is not exercised here; the join is what this file proves. */
const unusedClient: PolarClient = {
  createCheckoutSession: () => Effect.die("checkout is not part of a deploy"),
  createCustomerSession: () => Effect.die("portal is not part of a deploy"),
  createInvoice: () => Effect.die("invoice is not part of a deploy"),
  createRefund: () => Effect.die("refund is not part of a deploy"),
};

test.provider("joins provisioning and the provider into one call", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const billing = yield* stack.deploy(
      PolarBilling("Billing", {
        accessToken: "polar_fake",
        origin: "https://app.example.com",
        tiers: { pro: proPrice },
        client: unusedClient,
      }),
    );

    // The deploy's product is the provider's product, not a second one.
    expect(billing.sold.products.pro.startsWith("prod_")).toBe(true);
    expect(polar.products.size).toBe(1);
    expect(billing.prices).toEqual({ pro: proPrice });
    expect(billing.capabilities.has("checkout")).toBe(true);
  }),
);

test.provider("creates one product per tier, and a second deploy changes nothing", (stack) =>
  Effect.gen(function* () {
    polar.reset();
    const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
    const creates = polar.calls.filter((call) => call.startsWith("POST")).length;
    const second = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));

    expect(first.products.pro.startsWith("prod_")).toBe(true);
    expect(second.products.pro).toBe(first.products.pro);
    expect(polar.calls.filter((call) => call.startsWith("POST")).length).toBe(creates);
  }),
);

test.provider("adopts the product its metadata names after a lost state", (stack) =>
  Effect.gen(function* () {
    polar.reset();
    const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
    yield* stack.destroy();

    const adopted = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
    expect(adopted.products.pro).toBe(first.products.pro);
    expect(polar.products.size).toBe(1);
  }),
);

test.provider("a price change is a new generation, and the old one is kept", (stack) =>
  Effect.gen(function* () {
    polar.reset();
    const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));

    const changed = yield* stack.deploy(
      PolarPrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
    );

    expect(changed.products.pro).not.toBe(first.products.pro);
    expect(polar.products.size).toBe(2);
    expect(polar.products.get(first.products.pro)?.is_archived).toBe(false);
  }),
);

test.provider(
  "a later catalog price is a new generation, not a rollback to an older one",
  (stack) =>
    Effect.gen(function* () {
      polar.reset();
      const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));

      const second = yield* stack.deploy(
        PolarPrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
      );

      // Lose the state, then move the catalog back to the first price. The
      // newest generation is still the 2,400 one, so 1,900 is a new generation;
      // adopting the older 1,900 product would roll the tier backwards.
      yield* stack.destroy();
      const rolledBack = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));

      expect(rolledBack.products.pro).not.toBe(first.products.pro);
      expect(rolledBack.products.pro).not.toBe(second.products.pro);
      expect(polar.products.size).toBe(3);
    }),
);

test.provider("creates a one-time product for a one-off pack", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const sold = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: { credits: { price: { ...proPrice, amount: 9_900 }, kind: "one_off" } },
      }),
    );

    const product = polar.products.get(sold.products.credits);
    expect(product?.is_recurring).toBe(false);
    expect(product?.recurring_interval).toBe(null);

    const packed = product?.prices.find((price) => "price_amount" in price) as
      | { readonly price_amount: number }
      | undefined;

    expect(packed?.price_amount).toBe(9_900);
  }),
);

test.provider("creates a meter and a metered price from the catalog's unit price", (stack) =>
  Effect.gen(function* () {
    polar.reset();

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

    const product = polar.products.get(sold.products.pro);

    const metered = product?.prices.find((price) => "meter_id" in price) as
      | {
          readonly meter_id: string;
          readonly unit_amount: string;
          readonly price_currency: string;
        }
      | undefined;

    expect(metered?.unit_amount).toBe("2");
    expect(metered?.price_currency).toBe("usd");

    const meter = metered === undefined ? undefined : polar.meters.get(metered.meter_id);
    expect(meter?.aggregation).toEqual({ func: "sum", property: "units" });
    expect(meter?.filter.clauses[0]).toMatchObject({
      property: "name",
      value: sold.meters.messages,
    });
    expect(meter?.metadata.paykit_feature).toBe("messages");

    // A changed unit price is a new product generation; the meter is one per
    // feature and stays in place.
    const changed = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: {
          pro: {
            price: proPrice,
            usage: { messages: { amount: 3, currency: "usd" } },
          },
        },
      }),
    );

    expect(changed.products.pro).not.toBe(sold.products.pro);
    expect(polar.products.get(sold.products.pro)?.is_archived).toBe(false);
    expect(polar.meters.size).toBe(1);

    // The meter was already right. A reconcile that compared the aggregation it
    // sent (`metadata.units`) with the one Polar reports (`units`) would update
    // the meter on every deploy, and never converge.
    expect(
      polar.calls.filter((call) => call.startsWith("PATCH") && call.includes("/meters")),
    ).toEqual([]);
  }),
);

test.provider("a tier that leaves the catalog is retained, so a later deploy adopts it", (stack) =>
  Effect.gen(function* () {
    polar.reset();
    const first = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
    yield* stack.deploy(PolarPrices("Prices", { tiers: {} }));
    yield* stack.destroy();

    const again = yield* stack.deploy(PolarPrices("Prices", { tiers: { pro: proPrice } }));
    expect(again.products.pro).toBe(first.products.pro);
    expect(polar.products.size).toBe(1);
  }),
);

test.provider("creates a package metered price from the catalog's units", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const sold = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: {
          pro: {
            price: proPrice,
            usage: { messages: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
          },
        },
      }),
    );

    const product = polar.products.get(sold.products.pro);

    const metered = product?.prices.find((price) => "meter_id" in price) as
      | { readonly unit_amount: string }
      | undefined;

    expect(metered?.unit_amount).toBe("0.5");

    const again = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: {
          pro: {
            price: proPrice,
            usage: { messages: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
          },
        },
      }),
    );

    expect(again.products.pro).toBe(sold.products.pro);
  }),
);

test.provider("creates a tiered metered price from the catalog's ladder", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const sold = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: {
          pro: {
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
        },
      }),
    );

    const product = polar.products.get(sold.products.pro);

    const metered = product?.prices.find((price) => "meter_id" in price) as
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

    expect(metered?.amount_type).toBe("metered_tiers");
    expect(metered?.tiers.type).toBe("graduated");
    expect(metered?.tiers.tiers).toEqual([
      { bound: 100, unit_amount: "1" },
      { bound: null, unit_amount: "2" },
    ]);

    const again = yield* stack.deploy(
      PolarPrices("Prices", {
        tiers: {
          pro: {
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
        },
      }),
    );

    expect(again.products.pro).toBe(sold.products.pro);
  }),
);

test.provider(
  "adopts a tiered product after a lost state, and replaces a changed ladder",
  (stack) =>
    Effect.gen(function* () {
      polar.reset();

      const ladder = (infAmount: number) => ({
        kind: "graduated" as const,
        currency: "usd",
        bands: [
          { upTo: 100, amount: 1, currency: "usd" },
          { upTo: "inf" as const, amount: infAmount, currency: "usd" },
        ],
      });

      const tiers = (infAmount: number) => ({
        pro: { price: proPrice, usage: { messages: ladder(infAmount) } },
      });

      const first = yield* stack.deploy(PolarPrices("Prices", { tiers: tiers(2) }));
      const productId = first.products.pro;
      yield* stack.destroy();

      const adopted = yield* stack.deploy(PolarPrices("Prices", { tiers: tiers(2) }));
      expect(adopted.products.pro).toBe(productId);

      const changed = yield* stack.deploy(PolarPrices("Prices", { tiers: tiers(3) }));
      expect(changed.products.pro).not.toBe(productId);
      expect(polar.products.get(productId)?.is_archived).toBe(false);
    }),
);
