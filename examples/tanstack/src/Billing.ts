import { catalog, DevGuards, Manual, type MoneyProvider, paykitWorld } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { tanstackCatalog } from "./catalog.ts";

/** The catalog the deploy validates. */
export const Catalog = Effect.runSync(catalog(tanstackCatalog));

/** The example sells through an invoice, so it needs no provider key. */
export const Provider: MoneyProvider = Manual();

/**
 * The model, catalog, provider and development guard the Billing Worker
 * serves, plus the in-process operations. A purchase is an operation, not a
 * tenant command — it walks the provider's checkout or invoice path — so the
 * Worker that owns the provider is the only place it runs; the browser's atom
 * client never sees `Paykit.Subscribe`.
 *
 * `DevGuards` reads `x-paykit-actor`: the Website's server entry is the only
 * thing that sets it, from the browser's demo cookie. A real deployment
 * replaces `DevGuards` with `Paykit.GuardsFrom` over its session service, and
 * neither this file nor the Website changes.
 */
export const billingLayers = <R = never>(platform?: Layer.Layer<any, never, R>) =>
  paykitWorld({
    catalog: Catalog,
    guards: DevGuards,
    providers: [Provider],
    bindings: "tenant",
    ...(platform === undefined ? {} : { platform }),
  });

/** The layers the tests run, over an in-memory platform. */
export const BillingLayers = billingLayers();
export const BillingTestLive = BillingLayers;
