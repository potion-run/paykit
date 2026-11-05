import * as Domain from "@alchemy.run/domain";
import {
  catalog,
  catalogLayer,
  DevGuards,
  Manual,
  MemoryBillingReadStore,
  Model,
  Paykit,
  PaykitHandlers,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adminCatalog } from "./catalog.ts";

/** The catalog the deploy validates. */
export const Catalog = Effect.runSync(catalog(adminCatalog));

/** The example sells through an invoice; no provider key is needed. */
export const Provider = Manual();

/**
 * The model, catalog, provider and development guards the admin Worker
 * serves. The test swaps `DomainCloudflare.layerDurableObjects()` for
 * `Domain.InMemory`; nothing else changes.
 */
export const BillingLayers = Layer.mergeAll(
  Paykit.CatalogGuard.pipe(Layer.provideMerge(catalogLayer(Catalog))),
  Provider.payments,
).pipe(
  Layer.provideMerge(DevGuards),
  Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
  Layer.provideMerge(MemoryBillingReadStore),
);

/** The same world on an in-memory platform, for tests and local scripts. */
export const BillingTestLive = Layer.provide(BillingLayers, Domain.InMemory);
