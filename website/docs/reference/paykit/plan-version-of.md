---
title: "planVersionOf"
description: "The generation of a plan's terms the catalog currently sells, or null when the catalog has no such plan."
---

> **Source:** [`packages/paykit/src/Catalog.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Catalog.ts#L1172)
> **Kind:** Primitive

The generation of a plan's terms the catalog currently sells, or `null` when
the catalog has no such plan. A standing keeps the generation it was sold at,
so this is the version the next move buys, not the one already in force
(ADR 0047).

## Reading the generation a move would buy

```typescript
planVersionOf(catalog, "pro"); // 2
```
