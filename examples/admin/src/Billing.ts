import { Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";
import { CookieGuards } from "./Session.ts";

/** The catalog the deploy declares, for a test or a page that reads it. */
export const Catalog = billing.catalog;

/**
 * The model, catalog, provider and cookie guards the admin Worker serves. The
 * guards read the same-origin session cookie, so the browser's live reads can
 * be pushed over a WebSocket. The process serves the admin binding because the
 * console's refund runs it in-process: the Api and the console reads are
 * resolved from the model directly, but money moves through `Paykit.Refund`.
 *
 * The only difference between this and the test is the platform — the Worker
 * passes `DomainCloudflare.layerDurableObjects()`, the test takes the default
 * `Domain.InMemory`.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  guards: CookieGuards,
  bindings: "admin",
});
