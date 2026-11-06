import { catalog, Manual, paykitWorld } from "@potion.run/paykit";
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
 * be pushed over a WebSocket. The process serves no binding: the Api and the
 * console are resolved from the model directly.
 *
 * The only difference between this and the test is the platform — the Worker
 * passes `DomainCloudflare.layerDurableObjects()`, the test takes the default
 * `Domain.InMemory`.
 */
export const billingLayers = <R = never>(platform?: Layer.Layer<any, never, R>) =>
  paykitWorld({
    catalog: Catalog,
    guards: CookieGuards,
    providers: [Provider],
    bindings: "none",
    ...(platform === undefined ? {} : { platform }),
  });

/** The same world on an in-memory platform, for tests and local scripts. */
export const BillingTestLive = billingLayers();
