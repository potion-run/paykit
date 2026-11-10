---
title: "SqlConsumers"
description: "Exports `SqlViewStore`, `SqlPolicyStore`, `SqlStreamStore`."
---

> **Source:** [`packages/paykit/src/Store/SqlConsumers.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/SqlConsumers.ts#L94)

## SqlViewStore

> **Kind:** Primitive

A view's durable state: its snapshot, the entries it emitted and the input
log it dedupes by. Every row is a fold of `billing_event`, so dropping the
table and replaying the log is always allowed.

`receive` drops a delivery already in the input log by `(source, seq)`,
applies the rest through `kit.apply`, writes the snapshot, the entries and
the input rows in one `atomic` unit, then delivers downstream — so a crash
between the write and the delivery replays rather than skips.

## SqlPolicyStore

> **Kind:** Primitive

A policy's dedupe log. A policy hears every event it is responsible for, at
least once and in order per key; this row is what makes the second delivery
of one event a no-op instead of a second charge.

The handler runs before the row is written, so a crash between them replays
the policy — which is safe because every command it sends carries its own
command id.

## SqlStreamStore

> **Kind:** Primitive

A keyed, append-only stream. A write whose `origin` is not after the last
applied one is a repeat and is dropped, which is what makes a stream safe to
feed from an at-least-once producer.
