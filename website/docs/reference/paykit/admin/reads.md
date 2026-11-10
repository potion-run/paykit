---
title: "Reads"
description: "Exports `AdminReads`, `makeAdminReads`, `AdminReadsClient`."
---

> **Source:** [`packages/paykit/src/Admin/Reads.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Admin/Reads.ts#L450)

## AdminReads

> **Kind:** Primitive

The console's read port. It is deliberately separate from `BillingAdminApi`:
a Domain Api serves keyed reads, while an account list spans keys and
`Preview`/`Verify` are bindings over the pure model. A console needs both,
and this service is the one it depends on.

## makeAdminReads

> **Kind:** Layer

Build the read port from the in-process bindings. Provide the hosted model,
its `BillingReadStore` and the catalog; the same layer serves a test, an
`alchemy dev` console and a Worker that hosts the console beside the model.

## AdminReadsClient

> **Kind:** Layer

The browser/Worker client for `AdminReadsRpcs`, over Effect RPC's HTTP
protocol. Provide an `HttpClient` (for a browser, `FetchHttpClient.layer`);
the session cookie on the same origin authenticates every call.
