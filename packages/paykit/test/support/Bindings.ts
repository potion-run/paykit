import * as Layer from "effect/Layer";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import type { Catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { world } from "../../src/World.ts";

/** What a fixture may vary in the world it runs in. */
export interface BindingsWorldOptions<R = never> {
  readonly catalog: Catalog;
  /**
   * A model the test built itself. Use it when the fixture needs its own
   * platform, store or guards and the options below do not say it. The tenant
   * bindings are provided over it, exactly as `world` would.
   */
  readonly base?: Layer.Layer<any, never, R>;
  /** The auth guards; defaults to `InsecureDevGuards` when the world builds the model. */
  readonly guards?: Layer.Layer<any, never, R>;
  /** A pre-built money layer, for a test fake that is not a `MoneyProvider`. */
  readonly payments?: Layer.Layer<any, never, R>;
  /** The platform; defaults to `Domain.InMemory`. */
  readonly platform?: Layer.Layer<any, never, R>;
  /** The read store; defaults to `MemoryBillingReadStore`. */
  readonly readStore?: Layer.Layer<any, never, R>;
}

/**
 * A test world with the tenant bindings in it.
 *
 * The common case is the world a deployment builds, with the in-memory platform
 * and the development guards: `bindingsWorld({ catalog })`. A fixture that
 * needs a different platform, store, guard or money fake states it here instead
 * of assembling the graph again, and one that needs a model of its own passes
 * `base` and keeps the bindings provided over it.
 *
 * The bindings resolve the model, the catalog and the provider router when the
 * layer is built, so they are *provided* by the world rather than merged beside
 * it: a sibling does not see another sibling's services.
 *
 * ### A world with bindings
 * **Example:** The model, its store and every tenant verb
 * ```typescript
 * const World = bindingsWorld({ catalog: testCatalog });
 * ```
 *
 * @internal
 */
export const bindingsWorld = <R = never>(
  options: BindingsWorldOptions<R>,
): Layer.Layer<any, never, R> => {
  if (options.base === undefined) {
    return world({
      catalog: options.catalog,
      guards: options.guards ?? InsecureDevGuards,
      ...(options.payments === undefined ? {} : { payments: options.payments }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.readStore === undefined ? {} : { readStore: options.readStore }),
      bindings: "tenant",
    }) as Layer.Layer<any, never, R>;
  }
  const catalog = catalogLayer(options.catalog);
  const services =
    options.payments === undefined ? options.base : Layer.mergeAll(options.base, options.payments);
  return Layer.mergeAll(
    services,
    catalog,
    BillingInProcess.pipe(Layer.provide(services), Layer.provide(catalog)),
  ) as Layer.Layer<any, never, R>;
};
