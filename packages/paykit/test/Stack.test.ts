import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import { BillingStack, BillingStackAttrs } from "../src/BillingStack.resource.ts";
import { catalog } from "../src/Catalog.ts";
import { feature, messages } from "../src/Feature.ts";
import { PaymentsManual } from "../src/PaymentsManual.ts";
import { PaymentsMemory } from "../src/PaymentsMemory.ts";
import {
  CatalogPriceMismatch,
  D1Store,
  DurableObjectStore,
  MemoryStore,
  NoPurchasePath,
  Postgres,
  ProviderDuplicate,
  validateStack,
  providerDescriptor,
  validateProviderMappings,
} from "../src/Stack.ts";
import { tier } from "../src/Tier.ts";
import { assertProperty } from "./support/Property.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price: proPrice,
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const proCatalog = { features: [messages], tiers: [proTier] };

const unitPrice = { amount: 2, currency: "usd" } as const;

const postpaidTier = tier({
  id: "postpaid",
  price: proPrice,
  grants: [allowance(messages, { included: 100, overage: "bill", unitPrice })],
});

const postpaidCatalog = { features: [messages], tiers: [postpaidTier] };

describe("Stack", () => {
  it.effect("accepts a catalog and exposes the providers and store", () =>
    Effect.gen(function* () {
      const billing = yield* validateStack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory()],
        store: MemoryStore(),
      });

      expect(billing.catalog.features.length).toBe(1);
      expect(billing.catalog.tiers.length).toBe(1);
      expect(billing.providers.length).toBe(1);
      expect(billing.store._tag).toBe("MemoryStore");
    }),
  );

  it.effect("records a D1 ledger and a Durable Object ledger as their own kinds", () =>
    Effect.gen(function* () {
      const d1 = yield* validateStack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory()],
        store: D1Store(),
      });

      const durable = yield* validateStack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory()],
        store: DurableObjectStore(),
      });

      expect(d1.store._tag).toBe("D1Store");
      expect(durable.store._tag).toBe("DurableObjectStore");
    }),
  );

  it.effect("refuses a duplicate tier through the catalog error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateStack("Billing", { catalog: { features: [messages], tiers: [proTier, proTier] } }),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("CatalogDuplicateTier");
    }),
  );

  it.effect("refuses a tier that grants an undeclared feature", () =>
    Effect.gen(function* () {
      const haunted = tier({
        id: "haunted",
        grants: [allowance(feature({ id: "ghost" }), { included: 1 })],
      });

      const exit = yield* Effect.exit(
        validateStack("Billing", { catalog: { features: [messages], tiers: [haunted] } }),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("CatalogUnknownFeature");
    }),
  );

  it.effect("refuses a provider price that disagrees with the catalog", () =>
    Effect.gen(function* () {
      const provider = {
        ...PaymentsMemory(),
        prices: { pro: { amount: 2000, currency: "usd", interval: "month" as const } },
      };

      const exit = yield* Effect.exit(
        validateStack("Billing", { catalog: proCatalog, providers: [provider] }),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("CatalogPriceMismatch");

        const mismatch = new CatalogPriceMismatch({
          tier: "pro",
          field: "amount",
          expected: "1900",
          actual: "2000",
        });

        expect(mismatch._tag).toBe("CatalogPriceMismatch");
      }
    }),
  );

  it.effect("accepts a provider's unit price when it is the catalog's", () =>
    Effect.gen(function* () {
      const provider = {
        ...PaymentsMemory(),
        prices: { postpaid: proPrice },
        unitPrices: { postpaid: { messages: unitPrice } },
      };

      const billing = yield* validateStack("Billing", {
        catalog: postpaidCatalog,
        providers: [provider],
      });

      expect(billing.providers[0]?.unitPrices).toEqual({
        postpaid: { messages: unitPrice },
      });
    }),
  );

  it.effect("refuses a provider unit price that disagrees, naming the feature", () =>
    Effect.gen(function* () {
      const provider = {
        ...PaymentsMemory(),
        prices: { postpaid: proPrice },
        unitPrices: { postpaid: { messages: { amount: 3, currency: "usd" } } },
      };

      const error = yield* Effect.flip(
        validateStack("Billing", { catalog: postpaidCatalog, providers: [provider] }),
      );

      expect(error._tag).toBe("CatalogPriceMismatch");

      if (error._tag === "CatalogPriceMismatch") {
        expect(error.field).toBe("unitPrice.messages");
        expect(error.expected).toBe("2 usd");
        expect(error.actual).toBe("3 usd");
      }
    }),
  );

  it.effect("refuses a unit price for a feature the catalog does not price", () =>
    Effect.gen(function* () {
      const provider = {
        ...PaymentsMemory(),
        prices: { pro: proPrice },
        unitPrices: { pro: { messages: unitPrice } },
      };

      const error = yield* Effect.flip(
        validateStack("Billing", { catalog: proCatalog, providers: [provider] }),
      );

      expect(error._tag).toBe("CatalogPriceMismatch");

      if (error._tag === "CatalogPriceMismatch") expect(error.field).toBe("unitPrice.messages");
    }),
  );

  it.effect("refuses a usage provider that sells a postpaid tier without a meter mapping", () =>
    Effect.gen(function* () {
      const provider = {
        ...PaymentsMemory(),
        prices: { postpaid: proPrice },
      };

      const error = yield* Effect.flip(
        validateStack("Billing", { catalog: postpaidCatalog, providers: [provider] }),
      );

      expect(error._tag).toBe("CatalogPriceMismatch");

      if (error._tag === "CatalogPriceMismatch") {
        expect(error.field).toBe("unitPrice.messages");
        expect(error.actual).toBe("missing");
      }
    }),
  );

  it.effect("accepts a ladder and a package when the provider states the pricing", () =>
    Effect.gen(function* () {
      const ladder = tier({
        id: "ladder",
        price: proPrice,
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            pricing: {
              kind: "graduated",
              currency: "usd",
              bands: [
                { upTo: 100, amount: 1, currency: "usd" },
                { upTo: "inf", amount: 2, currency: "usd" },
              ],
            },
          }),
        ],
      });

      const ladderPricing = {
        _tag: "graduated" as const,
        currency: "usd",
        bands: [
          { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
          { upTo: "inf" as const, unitPrice: { amount: 2, currency: "usd" } },
        ] as const,
      };

      const ladderMissing = yield* Effect.flip(
        validateStack("Billing", {
          catalog: { features: [messages], tiers: [ladder] },
          providers: [{ ...PaymentsMemory(), prices: { ladder: proPrice } }],
        }),
      );

      expect(ladderMissing._tag).toBe("CatalogPriceMismatch");

      if (ladderMissing._tag === "CatalogPriceMismatch") {
        expect(ladderMissing.field).toBe("pricing.messages");
      }

      const ladderBilling = yield* validateStack("Billing", {
        catalog: { features: [messages], tiers: [ladder] },
        providers: [
          {
            ...PaymentsMemory(),
            prices: { ladder: proPrice },
            usagePrices: { ladder: { messages: ladderPricing } },
          },
        ],
      });

      expect(ladderBilling.id).toBe("Billing");

      const packagePrice = tier({
        id: "package",
        price: proPrice,
        grants: [
          allowance(messages, {
            included: 0,
            overage: "bill",
            pricing: { kind: "unit", amount: 500, currency: "usd", units: 1_000 },
          }),
        ],
      });

      const packageBilling = yield* validateStack("Billing", {
        catalog: { features: [messages], tiers: [packagePrice] },
        providers: [
          {
            ...PaymentsMemory(),
            prices: { package: proPrice },
            unitPrices: { package: { messages: { amount: 500, currency: "usd", units: 1_000 } } },
          },
        ],
      });

      expect(packageBilling.id).toBe("Billing");

      const packageError = yield* Effect.flip(
        validateStack("Billing", {
          catalog: { features: [messages], tiers: [packagePrice] },
          providers: [
            {
              ...PaymentsMemory(),
              prices: { package: proPrice },
              unitPrices: { package: { messages: { amount: 500, currency: "usd" } } },
            },
          ],
        }),
      );

      expect(packageError._tag).toBe("CatalogPriceMismatch");

      if (packageError._tag === "CatalogPriceMismatch") {
        expect(packageError.expected).toBe("500 usd per 1000 units");
      }
    }),
  );

  it.effect("accepts a package through the full usage pricing without the shorthand", () =>
    Effect.gen(function* () {
      const packageTier = tier({
        id: "package",
        price: proPrice,
        grants: [
          allowance(messages, {
            included: 0,
            overage: "bill",
            pricing: { kind: "unit", amount: 500, currency: "usd", units: 1_000 },
          }),
        ],
      });

      const billing = yield* validateStack("Billing", {
        catalog: { features: [messages], tiers: [packageTier] },
        providers: [
          {
            ...PaymentsMemory(),
            prices: { package: proPrice },
            usagePrices: {
              package: {
                messages: {
                  _tag: "unit",
                  unitPrice: { amount: 500, currency: "usd", units: 1_000 },
                },
              },
            },
          },
        ],
      });

      expect(billing.id).toBe("Billing");
    }),
  );

  it.effect("refuses a provider ladder whose band disagrees with the catalog", () =>
    Effect.gen(function* () {
      const ladder = tier({
        id: "ladder",
        price: proPrice,
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            pricing: {
              kind: "graduated",
              currency: "usd",
              bands: [
                { upTo: 100, amount: 1, currency: "usd" },
                { upTo: "inf", amount: 2, currency: "usd" },
              ],
            },
          }),
        ],
      });

      const error = yield* Effect.flip(
        validateStack("Billing", {
          catalog: { features: [messages], tiers: [ladder] },
          providers: [
            {
              ...PaymentsMemory(),
              prices: { ladder: proPrice },
              usagePrices: {
                ladder: {
                  messages: {
                    _tag: "graduated",
                    currency: "usd",
                    bands: [
                      { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
                      { upTo: "inf", unitPrice: { amount: 3, currency: "usd" } },
                    ],
                  },
                },
              },
            },
          ],
        }),
      );

      expect(error._tag).toBe("CatalogPriceMismatch");

      if (error._tag === "CatalogPriceMismatch") {
        expect(error.field).toBe("pricing.messages");
        expect(error.expected).toContain("inf=usd:2");
        expect(error.actual).toContain("inf=usd:3");
      }
    }),
  );

  it("a provider descriptor carries the full usage pricing", () => {
    const ladder = {
      _tag: "volume" as const,
      currency: "usd",
      bands: [
        { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
        { upTo: "inf" as const, unitPrice: { amount: 2, currency: "usd" } },
      ] as const,
    };

    const descriptor = providerDescriptor({
      ...PaymentsMemory(),
      prices: { postpaid: proPrice },
      usagePrices: { postpaid: { messages: ladder } },
    });

    expect(descriptor.usagePrices).toEqual({ postpaid: { messages: ladder } });
    expect(descriptor.unitPrices).toBe(undefined);
  });

  it.effect("requires a seat price from a provider that owns the subscription quantity", () =>
    Effect.gen(function* () {
      const seats = feature({ id: "seats", kind: "non_consumable" });

      const seatTier = tier({
        id: "team",
        price: proPrice,
        grants: [
          allowance(seats, {
            included: 5,
            overage: "bill",
            pricing: { kind: "unit", amount: 1_000, currency: "usd" },
            cap: 20,
          }),
        ],
      });

      const seatCatalog = { features: [seats], tiers: [seatTier] };

      const missing = yield* Effect.flip(
        validateStack("Billing", {
          catalog: seatCatalog,
          providers: [{ ...PaymentsMemory(), prices: { team: proPrice } }],
          store: MemoryStore(),
        }),
      );

      expect(missing._tag).toBe("CatalogPriceMismatch");

      if (missing._tag === "CatalogPriceMismatch") {
        expect(missing.field).toBe("seatPrice.seats");
        expect(missing.actual).toBe("missing");
      }

      const billing = yield* validateStack("Billing", {
        catalog: seatCatalog,
        providers: [
          {
            ...PaymentsMemory(),
            prices: { team: proPrice },
            seatPrices: { team: { seats: { amount: 1_000, currency: "usd" } } },
          },
        ],
        store: MemoryStore(),
      });

      expect(billing.id).toBe("Billing");
    }),
  );

  it.effect("refuses a subscription-wide seat count with two billable seat features", () =>
    Effect.gen(function* () {
      const seats = feature({ id: "seats", kind: "non_consumable" });
      const workspaces = feature({ id: "workspaces", kind: "non_consumable" });

      const seatTier = tier({
        id: "team",
        price: proPrice,
        grants: [
          allowance(seats, {
            included: 5,
            overage: "bill",
            pricing: { kind: "unit", amount: 1_000, currency: "usd" },
            cap: 20,
          }),
          allowance(workspaces, {
            included: 1,
            overage: "bill",
            pricing: { kind: "unit", amount: 2_000, currency: "usd" },
            cap: 10,
          }),
        ],
      });

      const seatCatalog = { features: [seats, workspaces], tiers: [seatTier] };

      const seatPrices = {
        team: {
          seats: { amount: 1_000, currency: "usd" },
          workspaces: { amount: 2_000, currency: "usd" },
        },
      };

      const error = yield* Effect.flip(
        validateStack("Billing", {
          catalog: seatCatalog,
          providers: [
            {
              ...PaymentsMemory(),
              prices: { team: proPrice },
              seatPrices,
              seatScope: "subscription",
            },
          ],
          store: MemoryStore(),
        }),
      );

      expect(error._tag).toBe("CatalogPriceMismatch");

      if (error._tag === "CatalogPriceMismatch") {
        expect(error.field).toBe("seatPrices");
        expect(error.actual).toBe("2");
      }

      // Stripe's subscription items are per feature, so the same catalog is
      // valid for a per-feature scope.
      const billing = yield* validateStack("Billing", {
        catalog: seatCatalog,
        providers: [
          {
            ...PaymentsMemory(),
            prices: { team: proPrice },
            seatPrices,
            seatScope: "feature",
          },
        ],
        store: MemoryStore(),
      });

      expect(billing.id).toBe("Billing");
    }),
  );

  it.effect("accepts a one-rate pricing the provider maps", () =>
    Effect.gen(function* () {
      const oneRate = tier({
        id: "one",
        price: proPrice,
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            pricing: { kind: "unit", amount: 2, currency: "usd" },
          }),
        ],
      });

      const billing = yield* validateStack("Billing", {
        catalog: { features: [messages], tiers: [oneRate] },
        providers: [
          {
            ...PaymentsMemory(),
            prices: { one: proPrice },
            unitPrices: { one: { messages: { amount: 2, currency: "usd" } } },
          },
        ],
        store: MemoryStore(),
      });

      expect(billing.id).toBe("Billing");
    }),
  );

  it.effect("refuses a priced tier with no purchase path", () =>
    Effect.gen(function* () {
      const manual = { ...PaymentsManual(), capabilities: new Set(["refund"] as const) };

      const exit = yield* Effect.exit(
        validateStack("Billing", { catalog: proCatalog, providers: [manual] }),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("NoPurchasePath");
      expect(new NoPurchasePath({ tier: "pro" })._tag).toBe("NoPurchasePath");
    }),
  );

  it.effect("keeps a database URL redacted in the store descriptor", () =>
    Effect.gen(function* () {
      const billing = yield* validateStack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory()],
        store: Postgres({
          url: Redacted.make("postgres://user:pass@localhost/billing"),
          schema: "billing",
        }),
      });

      expect(billing.store._tag).toBe("PostgresStore");

      if (billing.store._tag === "PostgresStore") {
        expect(Redacted.isRedacted(billing.store.url)).toBe(true);
      }
    }),
  );

  it.effect("keeps two providers apart, so an account stays on the one it paid through", () =>
    Effect.gen(function* () {
      const billing = yield* validateStack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory(), PaymentsManual()],
      });

      expect(billing.providers.map((provider) => provider.name)).toEqual(["memory", "manual"]);
    }),
  );

  it.effect("refuses two providers that share a name, which `refs` cannot tell apart", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateStack("Billing", {
          catalog: proCatalog,
          providers: [PaymentsMemory(), PaymentsMemory()],
        }),
      );

      expect(error._tag).toBe("ProviderDuplicate");

      if (error._tag === "ProviderDuplicate") expect(error.provider).toBe("memory");
    }),
  );

  it("a provider descriptor records whether the provider can report a payment", () => {
    const bare = providerDescriptor(PaymentsMemory());
    expect(bare.webhook).toBe(false);

    const wired = providerDescriptor({
      ...PaymentsMemory(),
      webhook: { provider: "memory", decode: () => Effect.succeedNone },
    });

    expect(wired.webhook).toBe(true);
  });

  it("a provider descriptor carries no runtime layer", () => {
    const descriptor = providerDescriptor({
      ...PaymentsMemory(),
      prices: { postpaid: proPrice },
      unitPrices: { postpaid: { messages: unitPrice } },
    });

    expect(descriptor.kind).toBe("memory");
    expect(descriptor.capabilities).toContain("checkout");
    expect(descriptor.unitPrices).toEqual({ postpaid: { messages: unitPrice } });
    expect("payments" in descriptor).toBe(false);
    expect(JSON.stringify(descriptor)).toContain("memory");
  });

  it("provider descriptors validate the same way the Stack effect does", () => {
    const parsed = Effect.runSync(
      validateStack("Billing", { catalog: proCatalog, providers: [PaymentsMemory()] }),
    );

    expect(validateProviderMappings(parsed.catalog, [providerDescriptor(PaymentsMemory())])).toBe(
      null,
    );
    expect(
      validateProviderMappings(parsed.catalog, [
        {
          name: "memory",
          kind: "memory",
          webhook: false,
          capabilities: ["checkout"],
          prices: { pro: { amount: 1, currency: "usd", interval: "month" } },
        },
      ]),
    ).toBeInstanceOf(CatalogPriceMismatch);
    expect(
      validateProviderMappings(parsed.catalog, [
        { name: "manual", kind: "manual", webhook: false, capabilities: ["refund"] },
      ]),
    ).toBeInstanceOf(NoPurchasePath);
    expect(
      validateProviderMappings(parsed.catalog, [
        { name: "memory", kind: "memory", webhook: false, capabilities: ["checkout"] },
        { name: "memory", kind: "manual", webhook: false, capabilities: ["invoice"] },
      ]),
    ).toBeInstanceOf(ProviderDuplicate);
  });

  it.effect("accepts exactly the catalog's prices, and names the field that disagrees", () => {
    const parsed = Effect.runSync(catalog(proCatalog));

    const base = {
      name: "p",
      kind: "memory",
      webhook: false,
      capabilities: ["checkout"] as const,
      prices: { pro: proPrice },
    };

    const Mutation = Schema.Literals([
      "exact",
      "amount",
      "currency",
      "interval",
      "missingTier",
      "duplicateName",
      "noPurchase",
    ]);

    return assertProperty(
      Arbitrary.schema(Mutation),
      (mutation) => {
        const result =
          mutation === "exact"
            ? validateProviderMappings(parsed, [base])
            : mutation === "duplicateName"
              ? validateProviderMappings(parsed, [base, { ...base }])
              : mutation === "noPurchase"
                ? validateProviderMappings(parsed, [{ ...base, capabilities: [] }])
                : validateProviderMappings(parsed, [
                    {
                      ...base,
                      prices:
                        mutation === "missingTier"
                          ? { pro: proPrice, missing: proPrice }
                          : {
                              pro: {
                                ...proPrice,
                                ...(mutation === "amount" ? { amount: proPrice.amount + 1 } : {}),
                                ...(mutation === "currency" ? { currency: "eur" } : {}),
                                ...(mutation === "interval" ? { interval: "annual" as const } : {}),
                              },
                            },
                    },
                  ]);

        if (mutation === "exact") return result === null;

        if (mutation === "duplicateName") return result?._tag === "ProviderDuplicate";

        if (mutation === "noPurchase") return result?._tag === "NoPurchasePath";

        if (result?._tag !== "CatalogPriceMismatch") return false;
        const field = mutation === "missingTier" ? "tier" : mutation;

        return result.field === field;
      },
      { runs: 20, size: 8 },
    );
  });

  it("the BillingStack resource declares serializable attributes", () => {
    expect(BillingStack.Aliases).toBe(undefined);

    const attrs = Schema.encodeSync(BillingStackAttrs)({
      catalog: proCatalog,
      tiers: ["pro"],
      providers: [{ name: "memory", kind: "memory", webhook: false, capabilities: ["checkout"] }],
      store: { _tag: "MemoryStore" },
    });

    expect(attrs.tiers).toEqual(["pro"]);
  });
});
