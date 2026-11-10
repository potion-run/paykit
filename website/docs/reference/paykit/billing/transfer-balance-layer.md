---
title: "TransferBalance.layer"
description: "Exports `TransferBalanceWrite`, `TransferBalanceLive`."
---

> **Source:** [`packages/paykit/src/Billing/TransferBalance.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/TransferBalance.layer.ts#L17)

## TransferBalanceWrite

> **Kind:** Primitive

The one write a transfer makes. A layer implements the send and answers the
receipt; the binding reads the entitlement view it waited for, so both
transports report the balances a caller's next read sees.

## TransferBalanceLive

> **Kind:** Layer · **Product:** Entities · **Provides:** `Paykit.TransferBalance`

The transfer verb: one command, then the entitlement view it waited for. The
two balances are read from the committed view rather than rebuilt from the
reply, so `fromAfter`/`toAfter` on the event and the numbers a caller reads
cannot disagree.
