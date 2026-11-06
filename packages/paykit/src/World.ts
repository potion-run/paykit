import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { BillingAdminInProcess } from "./Billing/BillingAdminInProcess.layer.ts";
import { BillingInProcess } from "./Billing/BillingInProcess.layer.ts";
import { MemoryBillingReadStore } from "./BillingReadStore.ts";
import type { Catalog } from "./Catalog.ts";
import { CatalogGuardLive } from "./CatalogGuard.ts";
import { catalogLayer } from "./CatalogService.ts";
import { PaykitHandlers, PaykitModel } from "./Paykit.model.ts";
import { type MoneyProvider, paymentsRouter } from "./Payments.ts";

/** A layer with its output erased and its requirements kept. */
type AnyLayer<R = never> = Layer.Layer<any, never, R>;

/**
 * What a paykit deployment needs, in the order it is declared.
 *
 * Only `catalog` is required. Every other field is a seam the deployment
 * chooses: the platform the model runs on, the store its read model uses, the
 * guards that authenticate a caller, the providers that move money, and which
 * binding surface the process serves.
 */
export interface PaykitWorldOptions<R = never> {
  /** The catalog the deploy validated; every binding reads it. */
  readonly catalog: Catalog;
  /**
   * The platform the model runs on. Defaults to `Domain.InMemory`, which is
   * what a test and `alchemy dev` use; a Worker provides
   * `DomainCloudflare.layerDurableObjects()` and a SQL host provides
   * `Layer.succeed(Domain.Platform, platform)`.
   */
  readonly platform?: AnyLayer<R>;
  /**
   * The read store the model's projections write and `List` reads. Defaults to
   * `MemoryBillingReadStore`; an SQL host provides `SqlBillingReadStore`.
   */
  readonly readStore?: AnyLayer<R>;
  /**
   * The auth guards, `Session` and `Admin`. Omitted when the host provides them
   * beside the world — a Worker that resolves its own session. There is no
   * development default: a deployment must choose, so the header guard cannot
   * reach production by accident.
   */
  readonly guards?: AnyLayer<R>;
  /** The money providers, in preference order. None means a local-only world. */
  readonly providers?: ReadonlyArray<MoneyProvider>;
  /**
   * A pre-built money layer, `Payments` or `PaymentsProvider`, for a test fake
   * that is not a `MoneyProvider`. Merged beside the router, not instead of it.
   */
  readonly payments?: AnyLayer<R>;
  /**
   * Which bindings the world provides. Defaults to `"tenant"`; a process that
   * serves the operator surface as well asks for `"both"`.
   */
  readonly bindings?: "tenant" | "admin" | "both" | "none";
}

const providersOf = (input: PaykitWorldOptions["providers"]): ReadonlyArray<MoneyProvider> =>
  input ?? [];

/**
 * One deployment graph, built from the parts a host chooses.
 *
 * The model is the centre: the catalog guard, the read store, the platform and
 * the provider router are provided to it, and the tenant and operator bindings
 * are provided from it. A caller that provides this layer can send exactly the
 * commands the chosen bindings serve, and a test, an example and a Worker differ
 * only in the options — the graph is the same one.
 *
 * The store is provided both to the handlers and outward, because `List` reads
 * the projection directly rather than through a view. A single provider's
 * `Payments` layer is merged too, so a route beside the world can call it
 * without rebuilding the choice; with two providers the router is the only
 * answer, because merging both would shadow one by merge order.
 *
 * ### A Worker's world
 * **Example:** The model, the catalog, the guards and both binding surfaces
 * ```typescript
 * const World = paykitWorld({
 *   catalog: Catalog,
 *   platform: DomainCloudflare.layerDurableObjects(),
 *   guards: CookieGuards,
 *   providers: [Provider],
 *   bindings: "both",
 * });
 * ```
 *
 * @primitive
 */
export const paykitWorld = <R = never>(options: PaykitWorldOptions<R>): AnyLayer<R> => {
  const catalog = catalogLayer(options.catalog);
  const reads = options.readStore ?? MemoryBillingReadStore;
  const platform = options.platform ?? Domain.InMemory;
  const providers = providersOf(options.providers);
  const router = paymentsRouter(...providers);
  const guards = options.guards === undefined ? [] : [options.guards];
  const payments = options.payments === undefined ? [] : [options.payments];

  const middleware = Layer.mergeAll(
    CatalogGuardLive.pipe(Layer.provideMerge(catalog)),
    router,
    ...guards,
    ...payments,
  );

  const model = PaykitModel.layer(
    // The close-time usage policy resolves the account's provider from this
    // router; without it a postpaid close is local-only.
    PaykitHandlers.pipe(Layer.provide(reads), Layer.provideMerge(router)),
  ).pipe(
    Layer.provideMerge(reads),
    Layer.provide(platform),
    Layer.provideMerge(middleware),
    Layer.provideMerge(catalog),
  );

  const bindings = options.bindings ?? "tenant";
  const tenant =
    bindings === "tenant" || bindings === "both"
      ? [BillingInProcess.pipe(Layer.provide(model), Layer.provide(router), Layer.provide(catalog))]
      : [];
  const admin =
    bindings === "admin" || bindings === "both"
      ? [BillingAdminInProcess.pipe(Layer.provide(model), Layer.provide(catalog))]
      : [];
  const only = providers.length === 1 ? providers[0] : undefined;

  return Layer.mergeAll(
    model,
    catalog,
    router,
    ...guards,
    ...payments,
    ...(only === undefined ? [] : [only.payments]),
    ...tenant,
    ...admin,
  ) as AnyLayer<R>;
};
