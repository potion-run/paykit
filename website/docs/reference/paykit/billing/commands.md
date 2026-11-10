---
title: "Commands"
description: "Exports `BillingCommands`, `BillingCommandsLive`, `BillingCommandsClient`."
---

> **Source:** [`packages/paykit/src/Billing/Commands.rpc.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Commands.rpc.ts#L237)

## BillingCommands

> **Kind:** Primitive

The deployment's catalog join, as a service. `BillingApiLayer` resolves this
service instead of `CatalogService`, so a client that only speaks the Api
needs no catalog copy.

## BillingCommandsLive

> **Kind:** Layer

The server-side implementation: the catalog and the standing are read here,
the command is built here, and the model is sent exactly once.

It is the same join `BillingInProcess` makes. The Api layer uses it through
the wire, and a test or a Worker can provide it directly when the model and
the client share a process.

## BillingCommandsClient

> **Kind:** Layer

The browser/Worker client for `BillingCommandsRpcs`. Provide an `HttpClient`
(for a browser, `FetchHttpClient.layer`); a same-origin session cookie
authenticates every call.

Point it at the commands route, which `Paykit.handler` mounts at
`${tenant}/commands` by default.
