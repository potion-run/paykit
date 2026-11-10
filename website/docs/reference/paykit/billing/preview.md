---
title: "Preview"
description: "Run the model's pure decide and report what a command would produce: the events, the state after them, and the proration it would charge."
---

> **Source:** [`packages/paykit/src/Billing/Preview.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Preview.binding.ts#L40)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Preview`

Run the model's pure `decide` and report what a command would produce: the
events, the state after them, and the proration it would charge. Nothing is
recorded, and the answer cannot disagree with the write it previews because
it is the same function.

A model refusal comes back as `_tag: "rejected"` — data, not a failure — so a
console or an agent can show *why* before anyone sends anything.

## Showing the charge first

```typescript
const preview = yield* Paykit.Preview(account);
const answer = yield* preview({ command: { kind: "changeTier", tier: "scale" } });
if (answer._tag === "accepted" && answer.proration !== undefined) show(answer.proration.due);
```
