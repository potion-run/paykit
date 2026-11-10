---
title: "Actor"
description: "The caller of a request, provided by the Session or Admin middleware and carried with the command."
---

> **Source:** [`packages/paykit/src/Auth/Actor.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Auth/Actor.ts#L23)
> **Kind:** Primitive

The caller of a request, provided by the `Session` or `Admin` middleware and
carried with the command. Read it in a `View`'s `validate` and in your own
middleware; `decide` stays pure and does not read it.

## Declaring a request context

```typescript
import * as Effect from "effect/Effect";

validate: Effect.fn(function* ({ key }) {
  const actor = yield* Actor;
  if (actor.kind === "account" && actor.id !== key.id) {
    return yield* new Forbidden({ account: key.id, actor: actor.id, kind: actor.kind, scope: "account" });
  }
}),
```
