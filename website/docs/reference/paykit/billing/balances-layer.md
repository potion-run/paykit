---
title: "Balances.layer"
description: "Exports `BalancesRead`, `BalancesLive`."
---

> **Source:** [`packages/paykit/src/Billing/Balances.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Balances.layer.ts#L27)

## BalancesRead

> **Kind:** Primitive

The read a `Balances` verb answers from: one account's entitlement view. It
exists so the binding composes once — the in-process layer reads the view,
the Api layer reads the same view over its client — instead of being written
twice and drifting.

## BalancesLive

> **Kind:** Layer · **Product:** Usage · **Provides:** `Paykit.Balances`

The balances surface, composed from the commands that already exist: a read
of the entitlement view, `SetUsage` for occupancy, and `SettleHold` /
`ReleaseHold` for a lock. It adds no second model and no second write path.
