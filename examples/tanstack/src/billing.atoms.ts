import { BillingApi } from "@potion.run/paykit";
import * as PaykitAtom from "@potion.run/paykit/Atom";
import { catalog, catalogLayer } from "@potion.run/paykit/Read";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { tanstackCatalog } from "./catalog.ts";

/**
 * The browser's catalog. It is the same data the Worker validates, so the
 * terms a tier change carries agree with the deploy; the server's
 * `CatalogGuard` is still the backstop.
 */
export const Catalog = Effect.runSync(catalog(tanstackCatalog));

/**
 * The paykit Atom client. `make` builds one runtime over the Api client and
 * the catalog:
 *
 * - `entitlements(account)` and `billing(account)` are queries, refreshed by
 *   every successful command below.
 * - `trackUsage`, `hold`, `settleHold`, `releaseHold`, `consumeCredits`,
 *   `scheduleCancellation`, `resume`, `scheduleTierChange`,
 *   `withdrawTierChange`, `startTrial` and `check` are commands: write a
 *   request, read the `AsyncResult`.
 *
 * The base URL is same-origin. `src/worker.ts` forwards it to the Billing
 * Worker over a service binding and attaches the actor header, so the browser
 * sends only its cookie. A client pointed at another origin would provide
 * `BindingCall` with the headers its deployment requires instead.
 */
export const billing = PaykitAtom.make({
  layer: Layer.mergeAll(
    catalogLayer(Catalog),
    BillingApi.layerClientHttp("/api/billing").pipe(Layer.provide(FetchHttpClient.layer)),
  ),
});
