import * as Effect from "effect/Effect";
import { BillingStack as BillingStackResource } from "./BillingStack.resource.ts";
import type { BillingStore } from "./BillingStack.resource.ts";
import type { BillingStackShape } from "./BillingStack.resource.ts";
import { catalog, type Catalog, type CatalogInput } from "./Catalog.ts";
import type { MoneyProvider } from "./Payments.ts";
import {
  MemoryStore,
  providerDescriptor,
  type ProviderDescriptor,
  type Store,
  validateProviderMappings,
} from "./Stack.ts";

/**
 * What a deploy declares: the catalog, the providers that sell it, and the
 * store its event log lives in. It is the same shape every surface takes, so a
 * deployment can export one `billing` object and pass it to `BillingStack`,
 * `world` and `PaykitAtom.make`.
 */
export interface BillingStackProps {
  /** Plain catalog data; provider ids belong in provider config, never here. */
  readonly catalog: CatalogInput;
  /**
   * The money plane, in preference order. The first is what a new account
   * starts on; an account that already holds a vendor reference stays on the
   * provider that reference names. Every name must be distinct.
   */
  readonly providers?: ReadonlyArray<MoneyProvider>;
  /** The store the deploy records. The runtime provides the matching layer. */
  readonly store?: Store;
}

/**
 * What the deploy call returns: the recorded resource, the catalog it
 * validated, the tier ids a console can list, and the serializable provider
 * descriptors that went into state.
 */
export interface BillingDeployment {
  /** The Alchemy resource, for a caller that needs its attributes. */
  readonly resource: BillingStackShape;
  /** The catalog the deploy validated. */
  readonly catalog: Catalog;
  /** Every tier id the catalog sells. */
  readonly tiers: ReadonlyArray<string>;
  /** The providers as state holds them. */
  readonly providers: ReadonlyArray<ProviderDescriptor>;
  /** The store the deployment declared. */
  readonly store: Store;
}

/**
 * The store kind a stack records. The connection URL is a runtime binding, so
 * it never reaches state; the tag and the schema are what a later deploy diffs.
 */
const storeKindOf = (store: Store): BillingStore => {
  switch (store._tag) {
    case "MemoryStore":
      return { _tag: "MemoryStore" };
    case "PostgresStore":
      return { _tag: "PostgresStore", schema: store.schema };
    case "SqliteStore":
      return { _tag: "SqliteStore", schema: store.schema };
    case "MySQLStore":
      return { _tag: "MySQLStore" };
  }
};

/**
 * The deploy-time billing stack, in one call.
 *
 * It validates the catalog, refuses a provider price that disagrees with it,
 * refuses two providers that share a name, and refuses a priced tier nothing
 * can sell. Then it records the result in `Paykit.BillingStack` state — the
 * event log is application data, so the resource is retained on destroy.
 *
 * The props take `MoneyProvider` values because that is what a deployment has.
 * The resource records `ProviderDescriptor`s because state is JSON: a
 * provider's `Layer` is runtime config, and the descriptor is what a later
 * deploy can diff. That mapping happens here, once, so `providerDescriptor`
 * never appears in user code.
 *
 * The error channel is the same tagged union `validateStack` returns, so
 * `Effect.orDie` at the stack boundary is a choice rather than a workaround.
 *
 * ### Deploying a catalog
 * **Example:** A free tier, a priced tier, and the manual provider
 * ```typescript
 * const billing = yield* Paykit.BillingStack("Billing", {
 *   catalog: { features: [messages], tiers: [free, pro] },
 *   providers: [Paykit.Manual()],
 *   store: Paykit.MemoryStore(),
 * });
 *
 * // billing.catalog — the validated catalog
 * // billing.tiers   — ["free", "pro"]
 * ```
 *
 * @primitive
 * @product Billing
 */
export const BillingStack = Effect.fn("Paykit.BillingStack")(function* (
  id: string,
  props: BillingStackProps,
) {
  const parsed = yield* catalog(props.catalog);
  const providers = props.providers ?? [];
  const descriptors = providers.map(providerDescriptor);
  const invalid = validateProviderMappings(parsed, descriptors);

  if (invalid !== null) return yield* invalid;
  const store = props.store ?? MemoryStore();

  const resource = yield* BillingStackResource(id, {
    catalog: parsed,
    providers: descriptors,
    store: storeKindOf(store),
  });

  return {
    resource,
    catalog: parsed,
    tiers: parsed.tiers.map((tier) => tier.id),
    providers: descriptors,
    store,
  };
});
