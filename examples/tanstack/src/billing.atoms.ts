import * as PaykitAtom from "@potion.run/paykit/Atom";

/**
 * The paykit Atom client. `make` builds one runtime over the HTTP Api:
 * `entitlements(account)` and `billing(account)` are queries, and every tenant
 * verb is a command that refreshes them.
 *
 * There is no catalog here. A command that names a plan (`startTrial`,
 * `scheduleTierChange`) sends the id; the Billing Worker expands it with the
 * catalog its model was built with, so the browser never holds a copy that can
 * go stale.
 *
 * The base URL is same-origin. `src/worker.ts` forwards it to the Billing
 * Worker over a service binding and attaches the actor header, so the browser
 * sends only its cookie. A client pointed at another origin provides
 * `BindingCall` with the headers its deployment requires instead.
 */
export const billing = PaykitAtom.make({
  url: "/api/billing",
});
