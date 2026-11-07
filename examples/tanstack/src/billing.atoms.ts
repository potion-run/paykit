import * as PaykitAtom from "@potion.run/paykit/Atom";

/**
 * The paykit Atom client. `make` builds one runtime over the HTTP Api:
 * `entitlements(account)` and `billing(account)` are queries, and every tenant
 * verb is a command that refreshes them.
 *
 * The catalog is not passed in. The client reads it from the deploy at
 * `/api/billing/catalog` when the runtime is built, so the browser joins a
 * tier's terms from the same value the Billing Worker validates — a bundled
 * second copy is a copy that can go stale.
 *
 * The base URL is same-origin. `src/worker.ts` forwards it to the Billing
 * Worker over a service binding and attaches the actor header, so the browser
 * sends only its cookie. A client pointed at another origin provides
 * `BindingCall` with the headers its deployment requires instead.
 */
export const billing = PaykitAtom.make({
  url: "/api/billing",
});
