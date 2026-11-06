import {
  catalog,
  Manual,
  type MoneyProvider,
  paykitWorld,
  subscribeInputOf,
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
 * The billing world on `MemoryStore`, so the example needs no billing
 * database; the auth database is a D1 database beside it. The tenant and
 * operator bindings are both served from one model, and the guards are not
 * here: the Worker provides them from its session, so the same model serves any
 * identity provider.
 */
export const billingLayers = <R = never>(platform?: Layer.Layer<any, never, R>) =>
  paykitWorld({
    catalog: Catalog,
    providers: [Provider],
    bindings: "both",
    ...(platform === undefined ? {} : { platform }),
  });

/** The example's test runs on the in-memory platform. */
export const BillingTestLive = billingLayers();

/**
 * The input a `Subscribe` carries for a tier. `decide` is pure and cannot look
 * a price up; `subscribeInputOf` is the package's join, and `CatalogGuard`
 * still refuses anything that disagrees with the deploy.
 */
export const tierCommand = (tierId: string) => {
  const input = subscribeInputOf(Catalog, tierId);
  if (input === null) throw new Error(`no tier ${tierId} in the catalog`);
  return input;
};
