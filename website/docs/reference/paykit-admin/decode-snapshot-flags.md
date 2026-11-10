---
title: "decodeSnapshotFlags"
description: "Decode what the host seeded."
---

> **Source:** [`packages/paykit-admin/src/Snapshot.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-admin/src/Snapshot.ts#L47)
> **Kind:** Primitive

Decode what the host seeded. Each snapshot is `Unknown` in `Flags` on
purpose: a snapshot the schema no longer matches is dropped, and `init`
asks the live read for the same thing instead. A stale deployment skew
costs a round trip, never boot.
