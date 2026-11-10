---
title: "Bindings"
description: "Exports `BindingFailed`, `BindingCall`."
---

> **Source:** [`packages/paykit/src/Billing/Bindings.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Bindings.ts#L8)

## BindingFailed

> **Kind:** Primitive

A binding could not reach the model at all: the transport failed, the reply did
not decode, or the call was not authenticated.

This is deliberately **not** a rejection. A rejection is a command the model
understood and refused, so the write did not happen and a caller may correct
the request. A `BindingFailed` means we do not know whether the write landed,
so a retry must carry the same `dedupeKey` rather than be treated as a new
attempt. Folding the two together would turn "no charge" and "unknown charge"
into one answer about money.

## BindingCall

> **Kind:** Primitive

How a binding authenticates the call it makes to a *remote* paykit surface.

A binding that runs in the same process as the model needs nothing: it sends
as the system actor, because the deployment already authenticated the work. A
binding that talks to another service needs the caller's own credentials, and
those belong to the deployment — a cookie, a bearer token, a signed header —
not to this package. Provide this service beside the Api-client protocol and
every outbound call carries it.

Absent, a remote binding sends no credentials, which is correct for an Api
served behind a signature at the edge or in a test.

### Carrying a session to a remote surface

```typescript
const Caller = Layer.succeed(BindingCall, { headers: { authorization: token } });

yield* trackUsage({ featureId: "messages", value: 1, idempotencyKey: requestId }).pipe(
  Effect.provide(Caller),
);
```
