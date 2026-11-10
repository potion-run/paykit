---
title: "List"
description: "One page of accounts, in a stable cursor order."
---

> **Source:** [`packages/paykit/src/Billing/List.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/List.binding.ts#L20)
> **Kind:** Binding · **Product:** Console · **Provides:** `Paykit.List`

One page of accounts, in a stable cursor order. This is the only read that
spans accounts — a view folds one key — so a dashboard, a past-due list and an
export all page through here.

`after` is the cursor a previous page returned in `next`, so a row created or
closed between two pages shifts nothing. A page is a snapshot: it says when it
was read (`asOf`), so a console can label it as point-in-time.

The bind takes nothing, because the scope is the deployment and not an
account — the one shape that is not `(account) => verb`.

## Paging past-due accounts

```typescript
const list = yield* Paykit.List();
let cursor: string | null = null;
do {
  const page = yield* list({ standing: "grace", take: 100, ...(cursor === null ? {} : { after: cursor }) });
  cursor = page.next;
} while (cursor !== null);
```
