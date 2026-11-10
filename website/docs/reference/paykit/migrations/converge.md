---
title: "converge"
description: "Converge the shipped description against the target, additively."
---

> **Source:** [`packages/paykit/src/Migrations/Converge.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Migrations/Converge.ts#L119)
> **Kind:** Primitive

Converge the shipped description against the target, additively.

Reads every table's columns once, then:
- creates a table the target lacks (the shipped migration normally did this);
- adds a column the description has and the target lacks, when the column is
  nullable, or `NOT NULL` with a default, and not a key;
- ensures every index with `CREATE INDEX IF NOT EXISTS`.

It refuses — with a `MigrationError` naming the column — to add a primary key
or a `NOT NULL` column without a default: those need a backfill, which is a
committed migration file and a human's review, not a deploy-time guess.

Idempotent: a second run against a converged target applies no DDL.

## Examples

```ts
import * as Effect from "effect/Effect"
import { converge } from "@potion.run/paykit"

const changed = yield* converge(sql, { schema: "billing" })
if (changed.columns.length > 0) console.log("added", changed.columns)
```
