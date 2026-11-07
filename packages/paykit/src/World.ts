import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Admin, Session } from "./Auth/Guards.ts";
import { BillingAdminInProcess } from "./Billing/BillingAdminInProcess.layer.ts";
import { BillingInProcess } from "./Billing/BillingInProcess.layer.ts";
import type { BillingReadStore } from "./BillingReadStore.ts";
import { MemoryBillingReadStore } from "./BillingReadStore.ts";
import { catalog as validateCatalog, type Catalog, type CatalogInput } from "./Catalog.ts";
import { CatalogGuardLive } from "./CatalogGuard.ts";
import { catalogLayer } from "./CatalogService.ts";
import { PaykitHandlers, PaykitModel } from "./Paykit.model.ts";
import { type MoneyProvider, paymentsRouter } from "./Payments.ts";

/** The binding surfaces a world can serve. */
export type PaykitBindings = "tenant" | "admin" | "both" | "none";

/** The services a binding surface adds to the world. */
type BindingServices<B extends PaykitBindings> =
  | (B extends "tenant" | "both" ? Layer.Success<typeof BillingInProcess> : never)
  | (B extends "admin" | "both" ? Layer.Success<typeof BillingAdminInProcess> : never);

/**
 * What a paykit deployment needs, in the order it is declared.
 *
 * Only `catalog` is required. Every other field is a seam the deployment
 * chooses: the platform the model runs on, the store its read model uses, the
 * guards that authenticate a caller, the providers that move money, and which
 * binding surface the process serves.
 */
export interface PaykitWorldOptions<
  R = never,
  P = never,
  B extends PaykitBindings = PaykitBindings,
> {
  /** The catalog the deploy declared; the world validates it. */
  readonly catalog: CatalogInput;
  /**
   * The platform the model runs on. Defaults to `Domain.InMemory`, which is
   * what a test and `alchemy dev` use; a Worker provides
   * `DomainCloudflare.layerDurableObjects()` and a SQL host provides
   * `Layer.succeed(Domain.Platform, platform)`.
   */
  readonly platform?: Layer.Layer<Domain.Platform, never, R>;
  /**
   * The read store the model's projections write and `List` reads. Defaults to
   * `MemoryBillingReadStore`; an SQL host provides `SqlBillingReadStore`.
   */
  readonly readStore?: Layer.Layer<BillingReadStore, never, R>;
  /**
   * The auth guards, `Session` and `Admin`. Omitted when the host provides them
   * beside the world — a Worker that resolves its own session. There is no
   * development default: a deployment must choose, so the header guard cannot
   * reach production by accident.
   */
  readonly guards?: Layer.Layer<Session | Admin, never, R>;
  /** The money providers, in preference order. None means a local-only world. */
  readonly providers?: ReadonlyArray<MoneyProvider>;
  /**
   * A pre-built money layer, `Payments` or `PaymentsProvider`, for a test fake
   * that is not a `MoneyProvider`. Merged beside the router, not instead of it.
   * Its services are part of the world's output, so a caller keeps them typed.
   */
  readonly payments?: Layer.Layer<P, never, R>;
  /**
   * Which bindings the world provides. Defaults to `"tenant"`; a process that
   * serves the operator surface as well asks for `"both"`.
   */
  readonly bindings?: B;
}

const providersOf = (input: PaykitWorldOptions["providers"]): ReadonlyArray<MoneyProvider> =>
  input ?? [];

const buildWorld = <R = never, P = never, B extends PaykitBindings = "tenant">(
  parsed: Catalog,
  options: PaykitWorldOptions<R, P, B>,
) => {
  const catalog = catalogLayer(parsed);
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
      ? [
          BillingAdminInProcess.pipe(
            Layer.provide(model),
            // The refund resolves the account's provider when the layer is
            // built, exactly as `BillingInProcess` does for its money verbs.
            Layer.provide(router),
            Layer.provide(catalog),
          ),
        ]
      : [];
  const only = providers.length === 1 ? providers[0] : undefined;

  // The common half — the model, the catalog, the router and the host's
  // services — is what every surface sees. The cast is the one place the
  // runtime `bindings` choice narrows the type: a `"tenant"` world does not
  // build the operator layer, so the union the merge would infer is wider than
  // what exists.
  const base = Layer.mergeAll(
    model,
    catalog,
    router,
    ...guards,
    ...payments,
    ...(only === undefined ? [] : [only.payments]),
  );
  return Layer.mergeAll(base, ...tenant, ...admin) as Layer.Layer<
    Layer.Success<typeof base> | BindingServices<B>,
    never,
    R
  >;
};

/**
 * One deployment graph, built from the parts a host chooses.
 *
 * The model is the centre: the catalog guard, the read store, the platform and
 * the provider router are provided to it, and the tenant and operator bindings
 * are provided from it. A caller that provides this layer can send exactly the
 * commands the chosen bindings serve, and a test, an example and a Worker differ
 * only in the options — the graph is the same one.
 *
 * The catalog is validated here, in the layer's error channel. A deploy
 * validates the same declaration with `Paykit.BillingStack`; a runtime that
 * cannot decode it is a defect the host handles once, at its boundary, instead
 * of an `Effect.runSync` that throws at module load.
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
 * const World = Paykit.world({
 *   catalog: billingCatalog,
 *   platform: DomainCloudflare.layerDurableObjects(),
 *   guards: CookieGuards,
 *   providers: [Provider],
 *   bindings: "both",
 * });
 * ```
 *
 * @primitive
 */
export const world = <R = never, P = never, B extends PaykitBindings = "tenant">(
  options: PaykitWorldOptions<R, P, B>,
) =>
  Layer.unwrap(
    Effect.map(validateCatalog(options.catalog), (parsed) => buildWorld(parsed, options)),
  );
