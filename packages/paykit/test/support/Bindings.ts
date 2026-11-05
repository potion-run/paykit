import * as Layer from "effect/Layer";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import type { Catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";

/**
 * A test world with the tenant bindings in it.
 *
 * The bindings resolve the model, the catalog and the provider router when the
 * layer is built, so they are *provided* by the world rather than merged beside
 * it: a sibling does not see another sibling's services. Every suite that calls
 * a binding goes through here, so there is one answer to "how does a test get a
 * `TrackUsage`", and the answer is the same one a deployment uses.
 *
 * ### A world with bindings
 * **Example:** The model, its store and every tenant verb
 * ```typescript
 * const base = PaykitModel.layer(PaykitHandlers).pipe(
 *   Layer.provideMerge(MemoryBillingReadStore),
 *   Layer.provide(Domain.InMemory),
 * );
 * const World = bindingsWorld(base, { catalog: testCatalog });
 * ```
 *
 * @internal
 */
export const bindingsWorld = (
  base: Layer.Layer<any, never, never>,
  options: {
    readonly catalog: Catalog;
    /** The provider layer a purchase, portal or proration call reaches. */
    readonly providers?: Layer.Layer<any, never, never>;
  },
): Layer.Layer<any, never, never> => {
  const catalog = catalogLayer(options.catalog);
  const services = options.providers === undefined ? base : Layer.mergeAll(base, options.providers);
  return Layer.mergeAll(
    services,
    catalog,
    BillingInProcess.pipe(Layer.provide(services), Layer.provide(catalog)),
  ) as Layer.Layer<any, never, never>;
};
