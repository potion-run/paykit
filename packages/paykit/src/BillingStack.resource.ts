import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { catalog, Catalog } from "./Catalog.ts";
import { ProviderDescriptor, validateProviderMappings } from "./Stack.ts";

/** The store kind a stack records; the connection URL is a runtime binding. */
export const BillingStore = Schema.Union([
  Schema.TaggedStruct("MemoryStore", {}),
  Schema.TaggedStruct("PostgresStore", { schema: Schema.String }),
  Schema.TaggedStruct("SqliteStore", { schema: Schema.String }),
]);
export type BillingStore = typeof BillingStore.Type;

export const BillingStackProps = Schema.Struct({
  catalog: Catalog,
  providers: Schema.optionalKey(Schema.Array(ProviderDescriptor)),
  store: Schema.optionalKey(BillingStore),
});
export type BillingStackProps = typeof BillingStackProps.Type;

export const BillingStackAttrs = Schema.Struct({
  catalog: Catalog,
  tiers: Schema.Array(Schema.String),
  providers: Schema.Array(ProviderDescriptor),
  store: BillingStore,
});
export type BillingStackAttrs = typeof BillingStackAttrs.Type;

export type BillingStackResource = Resource<
  "Paykit.BillingStack",
  BillingStackProps,
  BillingStackAttrs
>;

/**
 * The deploy-time billing stack. It validates the catalog and every provider
 * mapping and records the result in state; the event log is application data,
 * so the default removal policy is `retain`. Removing the resource never
 * cancels, refunds or deletes a provider's state.
 */
export const BillingStack = Resource<BillingStackResource>("Paykit.BillingStack", {
  defaultRemovalPolicy: "retain",
});

/** The Alchemy provider for `BillingStack`. */
export const BillingStackProvider = () =>
  Provider.succeed(BillingStack, {
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        const parsed = yield* catalog(news.catalog);
        const providers = news.providers ?? [];
        const invalid = validateProviderMappings(parsed, providers);
        if (invalid !== null) return yield* invalid;
        return {
          catalog: parsed,
          tiers: parsed.tiers.map((tier) => tier.id),
          providers,
          store: news.store ?? { _tag: "MemoryStore" as const },
        };
      }),
    read: ({ output }) => Effect.succeed(output),
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  });
