---
title: "SqlEventLog"
description: "The durable half of the store: events are the truth, receipts dedupe by command id, the outbox carries deliveries, and the read model is rebuildable."
---

> **Source:** [`packages/paykit/src/Store/SqlEventLog.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/SqlEventLog.ts#L90)
> **Kind:** Primitive

The durable half of the store: events are the truth, receipts dedupe by
command id, the outbox carries deliveries, and the read model is
rebuildable.

Every method is an `Effect`: a statement's answer arrives asynchronously on
every target worth supporting (D1 over HTTP, a `pg` client), and a store that
pretends otherwise cannot reach one. `append` runs as one `atomic` unit, so
the events, the state, the receipt and the deliveries land together or not
at all.

## Examples

```ts
import { SqlEventLog } from "@potion.run/paykit"

const log = SqlEventLog(sql, { now: () => 1_700_000_000_000, schema: "billing" })
const { version } = yield* log.append({ ... })
```
