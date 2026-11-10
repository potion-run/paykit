---
title: "doctor"
description: "Rebuild every read model from billing_event and diff it."
---

> **Source:** [`packages/paykit/src/Doctor.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Doctor.ts#L21)
> **Kind:** Primitive

Rebuild every read model from `billing_event` and diff it. A mismatch is a
read model that became a source of truth, or a projection that drifted.

The log is read asynchronously, so this is an `Effect`: a doctor that cannot
reach the database is a diagnostic that cannot run.
