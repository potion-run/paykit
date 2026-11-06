import * as PaykitAtom from "@potion.run/paykit/Atom";
import { billing as config } from "./billing.config.ts";

/**
 * The paykit Atom client. `make` builds one runtime over the HTTP Api and the
 * catalog: `entitlements(account)` and `billing(account)` are queries, and
 * every tenant verb is a command that refreshes them.
 *
 * The base URL is same-origin. `src/worker.ts` forwards it to the Billing
 * Worker over a service binding and attaches the actor header, so the browser
 * sends only its cookie. A client pointed at another origin provides
 * `BindingCall` with the headers its deployment requires instead.
 */
export const billing = PaykitAtom.make({
  url: "/api/billing",
  catalog: config.catalog,
});
