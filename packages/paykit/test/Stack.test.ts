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
  MemoryStore,
  NoPurchasePath,
  Postgres,
  ProviderDuplicate,
  Stack,
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
      const billing = yield* Stack("Billing", {
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

  it.effect("refuses a duplicate tier through the catalog error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Stack("Billing", { catalog: { features: [messages], tiers: [proTier, proTier] } }),
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
        Stack("Billing", { catalog: { features: [messages], tiers: [haunted] } }),
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
        Stack("Billing", { catalog: proCatalog, providers: [provider] }),
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
      const billing = yield* Stack("Billing", {
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
        Stack("Billing", { catalog: postpaidCatalog, providers: [provider] }),
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
        Stack("Billing", { catalog: proCatalog, providers: [provider] }),
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
        Stack("Billing", { catalog: postpaidCatalog, providers: [provider] }),
      );
      expect(error._tag).toBe("CatalogPriceMismatch");
      if (error._tag === "CatalogPriceMismatch") {
        expect(error.field).toBe("unitPrice.messages");
        expect(error.actual).toBe("missing");
      }
    }),
  );

  it.effect("refuses a priced tier with no purchase path", () =>
    Effect.gen(function* () {
      const manual = { ...PaymentsManual(), capabilities: new Set(["refund"] as const) };
      const exit = yield* Effect.exit(
        Stack("Billing", { catalog: proCatalog, providers: [manual] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("NoPurchasePath");
      expect(new NoPurchasePath({ tier: "pro" })._tag).toBe("NoPurchasePath");
    }),
  );

  it.effect("keeps a database URL redacted in the store descriptor", () =>
    Effect.gen(function* () {
      const billing = yield* Stack("Billing", {
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
      const billing = yield* Stack("Billing", {
        catalog: proCatalog,
        providers: [PaymentsMemory(), PaymentsManual()],
      });
      expect(billing.providers.map((provider) => provider.name)).toEqual(["memory", "manual"]);
    }),
  );

  it.effect("refuses two providers that share a name, which `refs` cannot tell apart", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Stack("Billing", {
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
      Stack("Billing", { catalog: proCatalog, providers: [PaymentsMemory()] }),
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
