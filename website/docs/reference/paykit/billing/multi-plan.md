---
title: "MultiPlan"
description: "Exports `MultiAttach`, `MultiUpdate`."
---

> **Source:** [`packages/paykit/src/Billing/MultiPlan.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/MultiPlan.binding.ts#L261)

## MultiAttach

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.MultiAttach`

Attach several plans in one transaction: a plan into a new group, an add-on
beside it, or a phase for a later boundary. The whole request is one command
with one retry key, so a retry replays the plan set or none of it.

### Attaching a second group and an add-on

```typescript
const multi = yield* Paykit.MultiAttach(account);
yield* multi({
  plans: [{ planId: "support" }, { planId: "analytics", planSchedule: "end_of_cycle" }],
  idempotencyKey: "plan-set-1",
});
```

## MultiUpdate

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.MultiUpdate`

Change several plans in one transaction. It is `multiAttach` under the name
an update uses: a plan set move, a phase and (once the group commands land) a
cancellation, all under one command id.
