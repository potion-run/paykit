import * as Domain from "@alchemy.run/domain";
import {
  catalog,
  catalogLayer,
  Manual,
  MemoryBillingReadStore,
  Model,
  type MoneyProvider,
  Paykit,
  PaykitHandlers,
  tierTermsOf,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { authCatalog } from "./catalog.ts";

/** The catalog the deploy validates. */
export const Catalog = Effect.runSync(catalog(authCatalog));

/**
 * The provider the example runs: `Manual` sells through an invoice, so no
 * provider key is needed. Replacing this with `Polar(...)` or `Stripe(...)` is
 * the whole provider change.
 */
export const Provider: MoneyProvider = Manual();

/**
 * The model on `MemoryStore`, so the example needs no billing database. The
 * auth database is a D1 database beside it — the two stores are unrelated, and
 * swapping this for `Paykit.SqlAggregateStore` changes nothing about auth.
 */
export const BillingWorld = Layer.mergeAll(
  Paykit.CatalogGuard.pipe(Layer.provideMerge(catalogLayer(Catalog))),
  Provider.payments,
).pipe(
  Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
  Layer.provideMerge(MemoryBillingReadStore),
  Layer.provideMerge(catalogLayer(Catalog)),
);

/**
 * The tenant and operator bindings over that world. The guards are not here:
 * the Worker provides them from its session, so the same model serves any
 * identity provider.
 */
export const BillingLayers = Layer.mergeAll(
  BillingWorld,
  Paykit.BillingInProcess.pipe(Layer.provide(BillingWorld)),
  Paykit.BillingAdminInProcess.pipe(Layer.provide(BillingWorld)),
);

/** The same world on an in-memory platform, for the example's test. */
export const BillingTestLive = Layer.provide(BillingLayers, Domain.InMemory);

/**
 * The fields a `Subscribe` command carries for a tier. `decide` is pure and
 * cannot look a price up, so the caller joins the catalog's terms; the
 * `CatalogGuard` refuses anything that disagrees with the deploy.
 */
export const tierCommand = (tierId: string) => {
  const terms = tierTermsOf(Catalog, tierId);
  if (terms === null) throw new Error(`no tier ${tierId} in the catalog`);
  return { tier: tierId, ...terms };
};
