---
title: "Meter"
description: "A Polar meter that sums one feature's billable units."
---

> **Source:** [`packages/paykit-polar/src/Meter.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Meter.ts#L78)
> **Kind:** Resource · **Product:** Meter

A Polar meter that sums one feature's billable units. Polar attaches a meter
to a metered price, so a postpaid feature needs one before `PolarPrices` can
create the price that charges it.

The identity is `metadata.paykit_feature = "<feature>"` plus the
stage-qualified name, `paykit:<stage>:meter:<feature>`. A restored state
reconciles to the same meter instead of creating a second one, and a meter
with no ownership metadata is never adopted.

The resource declares `retain`: a stack destroy drops Alchemy's state row and
leaves the meter in place for the prices that reference it. `PolarPrices`
still pipes `RemovalPolicy.retain` explicitly, and a call site that asks for
`destroy` archives the meter rather than deleting it.

## Declaring a meter

```typescript
const messages = yield* Meter("Meter_messages", { feature: "messages" });
// PolarPrices takes the meter id when it creates the metered price.
```
