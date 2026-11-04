import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { catalog, type Catalog, type CatalogError, type CatalogInput } from "./Catalog.ts";
import { PaymentCapability, type Provider } from "./Payments.ts";
import { Price, type Tier } from "./Tier.ts";

/** A provider's price for a tier disagrees with the catalog. */
export class CatalogPriceMismatch extends Schema.TaggedError<CatalogPriceMismatch>()(
  "CatalogPriceMismatch",
  {
    tier: Schema.String,
    field: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

/** A priced tier has no provider that can sell it. */
export class NoPurchasePath extends Schema.TaggedError<NoPurchasePath>()("NoPurchasePath", {
  tier: Schema.String,
}) {}

/** A provider as deploy state can hold it: no layer, no HTTP. */
export const ProviderDescriptor = Schema.Struct({
  kind: Schema.String,
  capabilities: Schema.Array(PaymentCapability),
  prices: Schema.optional(Schema.Record(Schema.String, Price)),
});
export type ProviderDescriptor = typeof ProviderDescriptor.Type;

/** Drop the runtime layer; keep what a deploy needs to validate and record. */
export const providerDescriptor = (provider: Provider): ProviderDescriptor => ({
  kind: provider.kind,
  capabilities: [...provider.capabilities],
  ...(provider.prices === undefined ? {} : { prices: provider.prices }),
});

/** The store a Stack writes its event log to. */
export type Store =
  | { readonly _tag: "MemoryStore" }
  | {
      readonly _tag: "PostgresStore";
      readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
      readonly schema: string;
    }
  | {
      readonly _tag: "SqliteStore";
      readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
      readonly schema: string;
    };

/** The in-memory store, for tests and `alchemy dev`. */
export const MemoryStore = (): Store => ({ _tag: "MemoryStore" });

/** The Postgres store config. The schema defaults to `billing`. */
export const Postgres = (props: {
  readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  readonly schema?: string;
}): Store => ({
  _tag: "PostgresStore",
  url: props.url,
  schema: props.schema ?? "billing",
});

/** The SQLite / D1 store config. The schema is unused there, kept for parity. */
export const Sqlite = (props: {
  readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  readonly schema?: string;
}): Store => ({
  _tag: "SqliteStore",
  url: props.url,
  schema: props.schema ?? "billing",
});

/** What a Stack declares. */
export interface StackProps {
  /** Plain catalog data; provider ids belong in provider config, never here. */
  readonly catalog: CatalogInput;
  readonly providers?: ReadonlyArray<Provider>;
  readonly store?: Store;
}

/** A validated stack: the catalog, the providers, and the store. */
export interface BillingStack {
  readonly id: string;
  readonly catalog: Catalog;
  readonly providers: ReadonlyArray<Provider>;
  readonly store: Store;
}

const priceField = (price: Price, field: keyof Price): string => String(price[field]);

/** Validate a catalog against serializable provider descriptors. */
export const validateProviderMappings = (
  parsed: Catalog,
  providers: ReadonlyArray<ProviderDescriptor>,
): CatalogPriceMismatch | NoPurchasePath | null => {
  for (const provider of providers) {
    for (const [tierId, mapped] of Object.entries(provider.prices ?? {})) {
      const tier = parsed.tiers.find((candidate) => candidate.id === tierId);
      if (tier === undefined) {
        return new CatalogPriceMismatch({
          tier: tierId,
          field: "tier",
          expected: "in catalog",
          actual: "missing",
        });
      }
      const mismatch = checkPrice(tier, mapped);
      if (mismatch !== null) return mismatch;
    }
  }
  for (const tier of parsed.tiers) {
    if (tier.price === undefined) continue;
    const canSell = providers.some(
      (provider) =>
        provider.capabilities.includes("checkout") || provider.capabilities.includes("invoice"),
    );
    if (!canSell) return new NoPurchasePath({ tier: tier.id });
  }
  return null;
};

/** Compare every mapped tier to the one meaning the catalog gives it. */
const checkPrice = (tier: Tier, mapped: Price): CatalogPriceMismatch | null => {
  if (tier.price === undefined) {
    return new CatalogPriceMismatch({
      tier: tier.id,
      field: "price",
      expected: "none",
      actual: priceField(mapped, "amount"),
    });
  }
  for (const field of ["amount", "currency", "interval"] as const) {
    if (tier.price[field] !== mapped[field]) {
      return new CatalogPriceMismatch({
        tier: tier.id,
        field,
        expected: priceField(tier.price, field),
        actual: priceField(mapped, field),
      });
    }
  }
  return null;
};

/**
 * Declare the billing stack: validate the catalog, refuse a provider price
 * that disagrees with it, and refuse a priced tier nothing can sell. The
 * provider's own price ids never reach the catalog.
 */
export const Stack = (
  id: string,
  props: StackProps,
): Effect.Effect<BillingStack, CatalogError | CatalogPriceMismatch | NoPurchasePath> =>
  Effect.gen(function* () {
    const parsed = yield* catalog(props.catalog);
    const providers = props.providers ?? [];
    const invalid = validateProviderMappings(parsed, providers.map(providerDescriptor));
    if (invalid !== null) return yield* invalid;
    return {
      id,
      catalog: parsed,
      providers,
      store: props.store ?? MemoryStore(),
    };
  });
