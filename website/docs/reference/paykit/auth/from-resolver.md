---
title: "FromResolver"
description: "Exports `ActorResolver`, `SessionFrom`, `authenticate`, `AdminFrom`, `GuardsFrom`."
---

> **Source:** [`packages/paykit/src/Auth/FromResolver.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Auth/FromResolver.ts#L24)

## ActorResolver

> **Kind:** Primitive

Resolve the caller a request carries, from whatever the deployment uses as a
session: a cookie, a bearer token, an identity provider SDK.

Return `null` for an anonymous request. A **failure** is a broken identity
store, not an anonymous caller, and becomes a defect: answering
`Unauthenticated` would sign a valid caller out because a database was slow.

### Resolving a caller from a session

```typescript
import * as Effect from "effect/Effect";

const resolve: Paykit.ActorResolver = ({ headers }) =>
  auth.getSession(headers).pipe(
    Effect.map((session) =>
      session === null ? null : Paykit.actorAccount(session.user.id),
    ),
  );

const guards = Paykit.GuardsFrom(resolve);
```

## SessionFrom

> **Kind:** Primitive

The tenant guard over a resolver. Every command and read a signed-in account
may reach declares it: it provides the resolved `Actor`, refuses an
anonymous request, and pins an `account` actor to its own account while an
`admin` or the `system` may target any.

This is the provider-neutral half of `InsecureSessionFromHeaders`: the billing model
never learns which identity provider answered. Better Auth, yielded/auth,
Clerk or a deployment's own session service all reduce to one resolver.

### Guarding the tenant surface with Better Auth

```typescript
const session = (headers: Headers.Input) =>
  auth.getSession(headers).pipe(
    Effect.map((found) => (found === null ? null : Paykit.actorAccount(found.user.id))),
  );

const Tenant = Paykit.SessionFrom(session);
```

## authenticate

> **Kind:** Primitive

Resolve the caller for a route that is not an Api: a checkout, a page, a
webhook dashboard. It is the same resolver the guards use and the same
`Unauthenticated` refusal, so a deployment has one identity mapping.

Unlike `SessionFrom` it does not pin the caller to a target; the route
decides what the actor may do with `mayActOn`.

### Resolving the caller for a checkout

```typescript
const actor = yield* Paykit.authenticate(resolve)({ headers, payload: null });
const subscribe = yield* Paykit.Subscribe(actor.id);
```

## AdminFrom

> **Kind:** Primitive

The operator guard over the same resolver. It requires an actor whose kind is
`admin`, so a tenant session cannot reach a command that grants credit,
expires a standing or replays a charge.

An `admin` actor may target any account, so unlike `SessionFrom` the
payload's target is not checked: acting across accounts is the point.

### Reaching the operator surface

```typescript
const admins = new Set(["ops@example.com"]);
const resolve: Paykit.ActorResolver = ({ headers }) =>
  auth.getSession(headers).pipe(
    Effect.map((session) =>
      session === null
        ? null
        : admins.has(session.user.email)
          ? Paykit.actorAdmin(session.user.id)
          : Paykit.actorAccount(session.user.id),
    ),
  );

const Operator = Paykit.AdminFrom(resolve);
```

## GuardsFrom

> **Kind:** Primitive

Both guards over one resolver, for a Worker that serves the tenant and the
operator surfaces from the same session.

### Serving both surfaces from one session

```typescript
const Guards = Paykit.GuardsFrom(resolve);

if (path.startsWith("/api")) return yield* tenant.fetch;
if (path.startsWith("/admin")) return yield* admin.fetch;
```
