import { Paykit } from "@potion.run/paykit";
import { billing } from "./billing.config.ts";

/** The catalog the deploy declares, for a test or a page that reads it. */
export const Catalog = billing.catalog;

/**
 * The layers the tests run, over an in-memory platform. The Worker builds the
 * same world with `layerDurableObjects()`; only the platform changes.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  guards: Paykit.InsecureDevGuards,
});
