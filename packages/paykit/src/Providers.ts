import * as Layer from "effect/Layer";
import { BillingStackProvider } from "./BillingStack.resource.ts";

/**
 * Every Alchemy provider this package owns, as one Layer, so a stack declares
 * `Paykit.providers()` beside `Cloudflare.providers()`.
 *
 * @layer
 */
export const providers = () => Layer.mergeAll(BillingStackProvider());
