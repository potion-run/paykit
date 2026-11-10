---
title: "Drizzle"
description: "The billing model on a Postgres database a Drizzle instance already opened."
---

> **Source:** [`packages/paykit/src/Database/Drizzle.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Drizzle.ts#L38)
> **Kind:** Layer · **Product:** Postgres · **Provides:** `paykit/Database` · **Peer dependencies:** `pg`

The billing model on a Postgres database a Drizzle instance already opened.

paykit never uses Drizzle's query builder — its stores write SQL through the
executor — so this layer is a connection adapter, not an ORM integration. It
unwraps `db.$client`, and every statement then runs on the pool the
application already owns: one pool, one transaction boundary, no second
connection string.

Only a `pg` pool is accepted. A Drizzle SQLite handle is better served by the
`Database/Sqlite` layer over the same file, and MySQL is not a paykit target
(a `TEXT` primary key needs a prefix length there, which is a different
schema, not a different dialect).

Import it from `@potion.run/paykit/Database/Drizzle`, not the barrel: `pg` is
an optional peer, and the client type is structural.

## The pool your application already has

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Drizzle } from "@potion.run/paykit/Database/Drizzle";

const db = drizzle({ client: pool });

Effect.gen(function* () {
  yield* Paykit.BillingStack("Billing", { ...billing, migrate: true });
}).pipe(Effect.provide(Drizzle(db, { schema: "billing" })));
```
