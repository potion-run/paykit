import * as Domain from "@alchemy.run/domain";
import {
  catalog,
  catalogLayer,
  Manual,
  MemoryBillingReadStore,
  Model,
  Paykit,
  PaykitHandlers,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adminCatalog } from "./catalog.ts";
import { CookieGuards } from "./Session.ts";

/** The catalog the deploy validates. */
export const Catalog = Effect.runSync(catalog(adminCatalog));

/** The example sells through an invoice; no provider key is needed. */
export const Provider = Manual();

/**
 * The model, catalog, provider and cookie guards the admin Worker serves. The
 * guards read the same-origin session cookie, so the browser's live reads can
 * be pushed over a WebSocket. The test swaps
 * `DomainCloudflare.layerDurableObjects()` for `Domain.InMemory`; nothing else
 * changes.
 */
export const BillingLayers = Layer.mergeAll(
  Paykit.CatalogGuard.pipe(Layer.provideMerge(catalogLayer(Catalog))),
  Provider.payments,
).pipe(
  Layer.provideMerge(CookieGuards),
  Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
  Layer.provideMerge(MemoryBillingReadStore),
);

/** The same world on an in-memory platform, for tests and local scripts. */
export const BillingTestLive = Layer.provide(BillingLayers, Domain.InMemory);
