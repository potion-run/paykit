---
title: "SqlPlatform"
description: "Exports `SqlPlatform`, `layerSqlPlatform`."
---

> **Source:** [`packages/paykit/src/Store/SqlPlatform.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/SqlPlatform.ts#L63)

## SqlPlatform

> **Kind:** Primitive

Host a model on SQL: every aggregate, view, policy, projection and stream
gets its rows in the same `billing_*` schema, and `billing_event` is the
only truth.

The platform keeps every consumer across deploys, so it also owns their
history. `start` catches up each view and projection that is new — or whose
declared version (its generation) changed — from the event log. A view keyed
by the one aggregate it reads is filled by each key on first touch instead
(Domain's `catchUp`), so a version bump does not need a long deploy-time
scan. The generation is recorded in `billing_rm_backfill`, so a restart skips
a completed consumer and a changed plan without a version bump fails the
build instead of silently reading the wrong history.

### Hosting paykit on SQLite

```typescript
const log = Paykit.SqlEventLog(sql, { now: () => Date.now() });
const { platform } = Paykit.SqlPlatform(sql, log, { now: () => Date.now() });
const world = Paykit.Model.layer(Paykit.ModelHandlers).pipe(
  Layer.provide(Layer.succeed(Domain.Platform, platform)),
);
```

## layerSqlPlatform

> **Kind:** Layer

The platform as a Layer, merged with the log so a binding can read it.
