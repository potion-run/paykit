---
title: "ChangeTier"
description: "Exports `AdminChangeTier`, `AdminChangeTierClient`."
---

> **Source:** [`packages/paykit/src/Admin/ChangeTier.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Admin/ChangeTier.ts#L125)

## AdminChangeTier

> **Kind:** Primitive

A catalog-owning `ChangeTier` sender. The aggregate's `decide` cannot look up
a price, and a client cannot reliably compute the proration at the instant
the server decides it. This binding builds the command from the catalog,
computes the proration with the server clock, and applies only when the
amount matches what the operator confirmed. A mismatch is a `requote`, never
a silently different charge.

## AdminChangeTierClient

> **Kind:** Layer

The browser/Worker client for the tier-change RPC. It shares the console's
endpoint with `AdminReadsClient`; the merged server group dispatches by tag.
