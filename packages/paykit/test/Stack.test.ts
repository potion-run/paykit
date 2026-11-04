import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import { BillingStack, BillingStackAttrs } from "../src/BillingStack.resource.ts";
import { feature, messages } from "../src/Feature.ts";
import { PaymentsManual } from "../src/PaymentsManual.ts";
import { PaymentsMemory } from "../src/PaymentsMemory.ts";
import {
  CatalogPriceMismatch,
  MemoryStore,
  NoPurchasePath,
  Postgres,
  ProviderAmbiguous,
  Stack,
  providerDescriptor,
  validateProviderMappings,
} from "../src/Stack.ts";
import { tier } from "../src/Tier.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price: proPrice,
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const proCatalog = { features: [messages], tiers: [proTier] };

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

  it.effect("refuses a second provider rather than letting it shadow the first", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Stack("Billing", {
          catalog: proCatalog,
          providers: [PaymentsMemory(), PaymentsManual()],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("ProviderAmbiguous");
      const ambiguous = new ProviderAmbiguous({ count: 2, kinds: ["memory", "manual"] });
      expect(ambiguous.count).toBe(2);
    }),
  );

  it("a provider descriptor carries no runtime layer", () => {
    const descriptor = providerDescriptor(PaymentsMemory());
    expect(descriptor.kind).toBe("memory");
    expect(descriptor.capabilities).toContain("checkout");
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
          kind: "memory",
          capabilities: ["checkout"],
          prices: { pro: { amount: 1, currency: "usd", interval: "month" } },
        },
      ]),
    ).toBeInstanceOf(CatalogPriceMismatch);
    expect(
      validateProviderMappings(parsed.catalog, [{ kind: "manual", capabilities: ["refund"] }]),
    ).toBeInstanceOf(NoPurchasePath);
    expect(
      validateProviderMappings(parsed.catalog, [
        { kind: "memory", capabilities: ["checkout"] },
        { kind: "manual", capabilities: ["invoice"] },
      ]),
    ).toBeInstanceOf(ProviderAmbiguous);
  });

  it("the BillingStack resource declares serializable attributes", () => {
    expect(BillingStack.Aliases).toBe(undefined);
    const attrs = Schema.encodeSync(BillingStackAttrs)({
      catalog: proCatalog,
      tiers: ["pro"],
      providers: [{ kind: "memory", capabilities: ["checkout"] }],
      store: { _tag: "MemoryStore" },
    });
    expect(attrs.tiers).toEqual(["pro"]);
  });
});
