---
title: "Postgres"
description: "A Postgres billing database, from any connection source: a Hyperdrive connection string, Neon, PlanetScale Postgres, RDS, or a literal URL."
---

> **Source:** [`packages/paykit/src/Database/Postgres.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Postgres.ts#L28)
> **Kind:** Layer · **Product:** Postgres · **Provides:** `paykit/Database` · **Peer dependencies:** `@effect/sql-pg`, `pg`

A Postgres billing database, from any connection source: a Hyperdrive
connection string, Neon, PlanetScale Postgres, RDS, or a literal URL.

One pool is opened per execution and closed when the event settles, which is
the only legal pooling shape on workerd. Migrations use `migrate` when it is
given, because the runtime URL may only exist inside the Worker — the same
split Alchemy's `Postgres` layer for Better Auth makes, and the reason a
deployment can keep a restricted runtime role.

Import it from `@potion.run/paykit/Database/Postgres`, not the barrel:
`@effect/sql-pg` is an optional peer.

## Pooled runtime, direct migrations

```ts
import { Postgres } from "@potion.run/paykit/Database/Postgres";

const Store = Postgres(hyperdrive.connectionString, {
  migrate: Config.redacted("POSTGRES_URL"),
  schema: "billing",
});
```
