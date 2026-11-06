import * as Domain from "@alchemy.run/domain";
import {
  catalog,
  catalogLayer,
  DevGuards,
  Manual,
  MemoryBillingReadStore,
  Model,
  type MoneyProvider,
  Paykit,
  PaykitHandlers,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { tanstackCatalog } from "./catalog.ts";

/** The catalog the deploy validates. */
export const Catalog = Effect.runSync(catalog(tanstackCatalog));

/** The example sells through an invoice, so it needs no provider key. */
export const Provider: MoneyProvider = Manual();

/**
 * The model, catalog, provider and development guard the Billing Worker
 * serves.
 *
 * `DevGuards` reads `x-paykit-actor`: the Website's server entry is the only
 * thing that sets it, from the browser's demo cookie. A real deployment
 * replaces `DevGuards` with `Paykit.GuardsFrom` over its session service, and
 * neither this file nor the Website changes.
 */
export const BillingWorld = Layer.mergeAll(
  Paykit.CatalogGuard.pipe(Layer.provideMerge(catalogLayer(Catalog))),
  Provider.payments,
).pipe(
  Layer.provideMerge(DevGuards),
  Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
  Layer.provideMerge(MemoryBillingReadStore),
  Layer.provideMerge(catalogLayer(Catalog)),
);

/**
 * The world plus the in-process operations. A purchase is an operation, not a
 * tenant command — it walks the provider's checkout or invoice path — so the
 * Worker that owns the provider is the only place it runs. The browser's atom
 * client never sees `Paykit.Subscribe`.
 */
export const BillingLayers = Layer.mergeAll(
  BillingWorld,
  Paykit.BillingInProcess.pipe(Layer.provide(BillingWorld)),
);

/** The same world on an in-memory platform, for the example's test. */
export const BillingTestLive = Layer.provide(BillingLayers, Domain.InMemory);
