import * as Domain from "@alchemy.run/domain";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Admin, Session } from "./Auth/Guards.ts";
import { BillingAdminInProcess } from "./Billing/BillingAdminInProcess.layer.ts";
import { BillingInProcess } from "./Billing/BillingInProcess.layer.ts";
import type { BillingReadStore } from "./BillingReadStore.ts";
import { MemoryBillingReadStore } from "./BillingReadStore.ts";
import type { Catalog, CatalogInput } from "./Catalog.ts";
import { CatalogGuardLive } from "./CatalogGuard.ts";
import { catalogLayer } from "./CatalogService.ts";
import { PaykitHandlers, PaykitModel } from "./Paykit.model.ts";
import { type MoneyProvider, PaymentsRouter, providerSet } from "./Payments.ts";
import { validateBilling } from "./Stack.ts";
import { autoTopUp } from "./Subscription/AutoTopUp.policy.ts";

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
  /**
   * Install the auto top-up policy. A tier's `topUp` line states when to refill
   * and which pack to buy, but the pack is a catalog id and a deployment has to
   * say which one its policy resolves when the tier names none. Omitted, a
   * crossing records nothing: a tier that states a line still never refills.
   *
   * The tier's own `pack` and `cooldown` win over these; this is the fallback a
   * line without them uses, and the budget for every line that states neither.
   */
  readonly autoTopUp?: {
    /** The `kind: "one_off"` pack a tier buys when its line names none. */
    readonly pack: string;
    /** The shortest time between two policy-opened purchases, for every tier. */
    readonly cooldown?: Duration.Duration;
  };
}

const providersOf = (input: PaykitWorldOptions["providers"]): ReadonlyArray<MoneyProvider> =>
  input ?? [];

const buildWorld = <R = never, P = never, B extends PaykitBindings = "tenant">(
  parsed: Catalog,
  options: PaykitWorldOptions<R, P, B>,
) =>
  // Scoped because the provider set builds each provider's `Payments` layer
  // once, here: its finalizers belong to the world, not to a single command.
  Layer.unwrap(
    Effect.gen(function* () {
      const catalog = catalogLayer(parsed);
      const reads = options.readStore ?? MemoryBillingReadStore;
      const platform = options.platform ?? Domain.InMemory;
      const providers = providersOf(options.providers);
      const set = yield* providerSet(providers);
      const router = Layer.succeed(PaymentsRouter, set);
      const guards = options.guards === undefined ? [] : [options.guards];
      const payments = options.payments === undefined ? [] : [options.payments];

      const middleware = Layer.mergeAll(
        CatalogGuardLive.pipe(Layer.provideMerge(catalog)),
        router,
        ...guards,
        ...payments,
      );

      // A tier's top-up line is catalog data, but the policy that acts on it is
      // a deployment's choice: without this layer a crossing records nothing and
      // the line is inert. The pack is resolved once, here, so a crossing never
      // reads the catalog.
      const refill =
        options.autoTopUp === undefined
          ? undefined
          : autoTopUp({
              catalog: parsed,
              pack: options.autoTopUp.pack,
              ...(options.autoTopUp.cooldown === undefined
                ? {}
                : { cooldown: options.autoTopUp.cooldown }),
            }).pipe(Layer.orDie);

      // The close-time usage policy resolves the account's provider from this
      // router; without it a postpaid close is local-only.
      const handlers = PaykitHandlers.pipe(Layer.provide(reads), Layer.provideMerge(router));

      const model = PaykitModel.layer(
        refill === undefined ? handlers : handlers.pipe(Layer.provide(refill)),
      ).pipe(
        Layer.provideMerge(reads),
        Layer.provide(platform),
        Layer.provideMerge(middleware),
        Layer.provideMerge(catalog),
      );

      const bindings = options.bindings ?? "tenant";

      const tenant =
        bindings === "tenant" || bindings === "both"
          ? [
              BillingInProcess.pipe(
                Layer.provide(model),
                Layer.provide(router),
                Layer.provide(catalog),
              ),
            ]
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

      // The single provider's services, built once above. A route beside the
      // world reads the same context a command resolves, so there is no second
      // build and no second client.
      const solePayments =
        only === undefined
          ? []
          : [
              // SAFETY: `providerSet` built a context for every provider it
              // registered, and `only` is one of them.
              Layer.succeedContext(set.contexts.get(only.name)!),
            ];

      // The common half — the model, the catalog, the router and the host's
      // services — is what every surface sees. The cast is the one place the
      // runtime `bindings` choice narrows the type: a `"tenant"` world does not
      // build the operator layer, so the union the merge would infer is wider
      // than what exists.
      const base = Layer.mergeAll(model, catalog, router, ...guards, ...payments, ...solePayments);

      // SAFETY: the merge provides exactly the services the layer union names.
      return Layer.mergeAll(base, ...tenant, ...admin) as Layer.Layer<
        Layer.Success<typeof base> | BindingServices<B>,
        never,
        R
      >;
    }),
  );

/**
 * One deployment graph, built from the parts a host chooses.
 *
 * The model is the centre: the catalog guard, the read store, the platform and
 * the provider router are provided to it, and the tenant and operator bindings
 * are provided from it. A caller that provides this layer can send exactly the
 * commands the chosen bindings serve, and a test, an example and a Worker differ
 * only in the options — the graph is the same one.
 *
 * The catalog and every declared provider mapping are validated here, in the
 * layer's error channel: a catalog that does not decode, a provider price that
 * disagrees with it, two providers that share a name, or — when the world
 * declares providers — a priced tier none of them can sell refuses the build. A
 * local-only world with no providers and a pre-built `payments` fake are the two
 * exemptions: neither is a deployment, so there is nothing to prove sellable. A
 * deploy validates the same declaration with `Paykit.BillingStack`; a runtime
 * that cannot decode it is a defect the host handles once, at its boundary,
 * instead of an `Effect.runSync` that throws at module load.
 *
 * The store is provided both to the handlers and outward, because `List` reads
 * the projection directly rather than through a view. A single provider's built
 * services are merged too — the same context a command resolves, not a second
 * build — so a route beside the world can call `Payments`; with two providers
 * the router is the only answer, because merging both would shadow one by merge
 * order.
 *
 * A tier's `topUp` line is catalog data, but the policy that acts on it is the
 * deployment's: `autoTopUp` installs it and names the pack a line without one
 * buys. Omitted, a crossing records nothing and the line is inert.
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
    Effect.map(
      validateBilling(options, {
        // A local-only world declares no provider, and a pre-built money layer
        // is a fake whose capabilities are not declared: neither can prove a
        // priced tier is sellable, and neither is a deployment.
        requirePurchasePath: options.payments === undefined && (options.providers?.length ?? 0) > 0,
      }),
      (billing) => buildWorld(billing.catalog, options),
    ),
  );
