---
title: "FromHeaders"
description: "Exports `accountFromHeaders`, `InsecureSessionFromHeaders`, `InsecureAdminFromHeaders`, `InsecureDevGuards`."
---

> **Source:** [`packages/paykit/src/Auth/FromHeaders.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Auth/FromHeaders.ts#L31)

## accountFromHeaders

> **Kind:** Primitive

The account id a request's development header names, for
`Paykit.handler`'s `accountOf`.

The same header the insecure guards read, reduced to the one field a
purchase needs. A deployment with its own session resolves its actor once,
in its auth file, and hands the handler that resolver's `actor.id`.

### A checkout's account

```typescript
const handler = yield* Paykit.handler({
  provider,
  accountOf: (request) => Paykit.accountFromHeaders(request.headers),
});
```

## InsecureSessionFromHeaders

> **Kind:** Layer

Insecure: it trusts the `x-paykit-actor` header, so any caller can name
itself. It exists so `alchemy dev`, the console and the tests can exercise
the guarded path without an identity provider.

Never expose this to the internet. A production deployment uses
[SessionFrom](/reference/paykit/auth/from-resolver) over its own session; the name is the warning.

## InsecureAdminFromHeaders

> **Kind:** Layer

Insecure: it trusts the `x-paykit-kind` header, so any caller can declare
itself an operator. It exists for the development console and the tests.

Never expose this to the internet. A production deployment uses
[AdminFrom](/reference/paykit/auth/from-resolver) over its own session.

## InsecureDevGuards

> **Kind:** Layer

Both insecure development guards, for a Worker that serves the tenant and the
admin surface from one process.

Never expose this to the internet.
