---
title: "make"
description: "Billing as Effect atoms: the tenant bindings, shaped for a client."
---

> **Source:** [`packages/paykit/src/Atom.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Atom.ts#L435)
> **Kind:** Primitive · **Product:** Usage

Billing as Effect atoms: the tenant bindings, shaped for a client.

`make` builds one runtime over the layer that reaches your Api — an HTTP
client in a browser, the in-process client in a test — and returns the
queries and commands a component reads. A successful command invalidates the
account's reactivity key, so `entitlements` and `billing` refresh after every
write without the caller wiring a subscription. `check` is a command atom
because the amount is part of the question.

The runtime is a normal `Atom.AtomRuntime`: compose an application query on
the same client with `billing.runtime.atom(...)`, and wrap it in
`billing.runtime.factory.withReactivity([PaykitAtom.accountReactivityKey(account)])`
to refresh it with the paykit writes.

## Reading an entitlement and tracking usage

```typescript
import { RegistryProvider, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as PaykitAtom from "@potion.run/paykit/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";

// No catalog: `startTrial` and `scheduleTierChange` name a plan, and the
// deployment expands it with the catalog its model was built with.
export const billing = PaykitAtom.make({
  url: "/api/billing",
});

const entitlements = billing.entitlements("acct_1");
const trackUsage = billing.trackUsage("acct_1");

function Usage() {
  const result = useAtomValue(entitlements);
  const view = AsyncResult.isSuccess(result) ? result.value : null;
  const track = useAtomSet(trackUsage, { mode: "promise" });
  return (
    <button onClick={() => track({ feature: "messages", amount: 1, dedupeKey: crypto.randomUUID() })}>
      {view?.features.messages?.remaining ?? "…"} left
    </button>
  );
}

export const App = () => (
  <RegistryProvider>
    <Usage />
  </RegistryProvider>
);
```
