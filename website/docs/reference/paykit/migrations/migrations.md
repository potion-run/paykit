---
title: "Migrations"
description: "Exports `migrationFiles`, `schemaFingerprint`, `migrationFingerprint`, `migrateDryRun`, `migrate`, `sync`."
---

> **Source:** [`packages/paykit/src/Migrations/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Migrations/index.ts#L85)

## migrationFiles

> **Kind:** Primitive

The migrations paykit ships, rendered for a dialect and schema. The list is
additive: a change appends a file, it never edits one already in the list.

### Examples

```ts
import { migrationFiles } from "@potion.run/paykit"

const [init] = migrationFiles({ dialect: "sqlite" })
console.log(init.id, init.sql)
```

## schemaFingerprint

> **Kind:** Primitive

The digest of the schema description rendered for a dialect: the DDL a
deploy would apply, without the migration wrapper. Two builds that create
the same tables hash the same, and adding a column, changing a type or
moving a key moves it.

`schema` defaults to `BILLING_SCHEMA`; a tool with a candidate description
can fingerprint that instead.

### Examples

```ts
import * as Effect from "effect/Effect"
import { schemaFingerprint } from "@potion.run/paykit"

const sqlite = yield* schemaFingerprint()
const postgres = yield* schemaFingerprint({ dialect: "postgres" })
```

## migrationFingerprint

> **Kind:** Primitive

The digest of the shipped migration set for a scope: its file ids, their
content hashes, and the dialect, schema and bookkeeping table it was
rendered for. It answers "did what we ship change", where
`schemaFingerprint` answers "did the table shape change". A schema or table
change counts even when the DDL bytes happen to match, because the registry
writes history under the table and routes DDL to the schema.

### Examples

```ts
import * as Effect from "effect/Effect"
import { migrationFingerprint } from "@potion.run/paykit"

const shipped = yield* migrationFingerprint({ dialect: "postgres", schema: "billing" })
```

## migrateDryRun

> **Kind:** Primitive

The SQL a dry run prints, in apply order: the schema, then every migration
with its id as a comment. The applied-migrations table is created by
`@alchemy.run/sql` and is not part of the money-table DDL.

### Examples

```ts
import { migrateDryRun } from "@potion.run/paykit"

console.log(migrateDryRun({ dialect: "postgres", schema: "billing" }))
```

## migrate

> **Kind:** Primitive

Apply every pending migration through `@alchemy.run/sql/Migrations`, which
owns the bookkeeping, content-hash drift detection and legacy upgrades. Each
file's statements and its bookkeeping row commit together, so a failed file
leaves no record and is retried on the next run.

The returned ids are the migrations this call records as applied; an
already-applied file is not returned, and a replay returns an empty array.
`schema` defaults to `billing` on Postgres and is ignored by SQLite.

On Postgres the executor must route every statement to one session (a
dedicated migration connection): the registry's bookkeeping queries are
unqualified, so this call scopes `search_path` and restores it afterwards.

### Examples

```ts
import * as Effect from "effect/Effect"
import { migrate } from "@potion.run/paykit"

const applied = yield* migrate(sqliteExecutor)
if (applied.length > 0) console.log("applied", applied)
```

## sync

> **Kind:** Primitive

Apply every pending migration, then converge the shipped description against
the target. This is what a deploy runs: the files are the baseline a reviewer
read, and the convergence is the additive delta between the description and
what the database actually has.

A redeploy over an up-to-date target applies nothing and adds nothing.

### Examples

```ts
import * as Effect from "effect/Effect"
import { sync } from "@potion.run/paykit"

const result = yield* sync(sql, { schema: "billing" })
console.log(result.applied, result.columns)
```
