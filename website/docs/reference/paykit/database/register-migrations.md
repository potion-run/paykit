---
title: "registerMigrations"
description: "Register the deploy-time migration Action for a Database, mirroring Alchemy's own BetterAuth.Migrate."
---

> **Source:** [`packages/paykit/src/Database/Migrate.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Migrate.ts#L137)
> **Kind:** Primitive

Register the deploy-time migration Action for a `Database`, mirroring
Alchemy's own `BetterAuth.Migrate`.

The Action's input is the target's identity, the shipped DDL's fingerprint,
the shipped files' fingerprint and the dialect. Any of them changing re-runs
it on the next deploy; an unchanged deploy is a no-op. That is the difference
from a hand-written Action keyed by a directory path, which a new migration
file cannot change.

The caller owns only `Database`: `Stack` and `RuntimeContext` are the stack's
own ambient services — present when a deploy evaluates the stack, absent when
a test or a Worker calls this, and the body returns before touching either in
that case.

It runs only during apply — never at plan, never inside the deployed runtime
— and its output is bound into the host environment, so a Worker depends on
the schema it needs. Call it from the stack, with the database layer
provided:

## Migrating on deploy

```ts
import { Postgres } from "@potion.run/paykit/Database/Postgres";

Effect.gen(function* () {
  yield* Paykit.registerMigrations("Billing");
  const worker = yield* BillingWorker;
  return { url: worker.url };
}).pipe(Effect.provide(Postgres(Config.redacted("POSTGRES_URL"))));
```
