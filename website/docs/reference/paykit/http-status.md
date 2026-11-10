---
title: "httpStatus"
description: "The HTTP status a paykit refusal deserves."
---

> **Source:** [`packages/paykit/src/HttpStatus.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/HttpStatus.ts#L1)
> **Kind:** Primitive

The HTTP status a paykit refusal deserves.

A refusal is not a server fault: an account that names a tier the catalog
does not sell sent a bad request, a caller with no session is unauthorised,
and a provider that cannot do what the deployment asked is not implemented.
The default is `500`, so a tag this map does not know still fails closed.

It takes any tagged value — `{ readonly _tag?: string }` — so it accepts the
package's refusals, a provider's `WebhookError`, and a deployment's own
error without importing the union.

## Answering a refusal

```typescript
const purchase = yield* Effect.result(subscribe({ tier }));
if (Result.isFailure(purchase)) {
  return HttpServerResponse.jsonUnsafe(
    { error: purchase.failure._tag },
    { status: Paykit.httpStatus(purchase.failure) },
  );
}
```
