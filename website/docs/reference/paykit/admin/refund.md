---
title: "Refund"
description: "Exports `AdminRefund`, `AdminRefundClient`."
---

> **Source:** [`packages/paykit/src/Admin/Refund.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Admin/Refund.ts#L91)

## AdminRefund

> **Kind:** Primitive

The refund port the console's server exposes. It runs the in-process
`Paykit.Refund` binding, so the process that serves the console is the one
that holds the provider: `BillingAdminApiLayer` deliberately has no refund,
because an Api backend that cannot reach the provider must not take money
out. The binding checks the ceiling before the provider call, so a refund
the model would refuse never leaves the account.

### Refunding from the console server

```typescript
// `AdminConsoleServer` builds this port from `Paykit.Refund`; a route beside
// the console can also provide `AdminRefundLive` and call it directly.
const refund = yield* AdminRefund;
const answer = yield* refund.refund({
  account: "acct_1",
  chargeId: "ch_123",
  amount: 1900,
  currency: "usd",
  commandId: ticketId,
});
```

## AdminRefundClient

> **Kind:** Layer

The browser/Worker client for the refund RPC. It shares the console's
endpoint with `AdminReadsClient` and `AdminChangeTierClient`; the merged
server group dispatches by tag.
