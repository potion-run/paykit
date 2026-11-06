import { Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/** The catalog the deploy declares, for a test or a page that reads it. */
export const Catalog = billing.catalog;

/** The provider the example runs; a test can swap it for a fake. */
export const Provider = billing.providers[0]!;

/**
 * The layers the tests run, over an in-memory platform. The Worker builds the
 * same world with `layerDurableObjects()`; only the platform changes.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  guards: Paykit.InsecureDevGuards,
});
