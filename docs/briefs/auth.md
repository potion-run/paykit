# Auth: the actor, the guard, and what a deployment must not forget

- **Status:** Partly landed; the open decisions are named at the end
- **Follows:** [0015](../adr/0015-a-runtime-binding-names-a-command.md)
- **Touches:** `packages/paykit/src/Auth`, `packages/paykit/src/Subscription/*.view.ts`,
  `packages/paykit-admin`, `examples/auth`, `examples/admin`, `examples/billing`,
  `examples/tanstack`

## What is already right

The model is deliberately small, and it should stay that way.

- **`Actor` is three fields.** `{ kind: "account" | "admin" | "system", id }`. A tenant may act on
  itself, an operator or the deployment's own sender may act on any account. `mayActOn` is pure,
  so the middleware and a view's `validate` cannot disagree.
- **`Session` and `Admin` are `RpcMiddleware` services, not route checks.** A command declares the
  weakest guard it needs; the Api's command list is the blast radius. A route cannot forget a guard
  because the model's own commands carry it.
- **The resolver is the identity seam.** `ActorResolver` takes `{ headers, payload }` and answers
  `ActorValue | null`. `SessionFrom` / `AdminFrom` / `GuardsFrom` turn it into layers. Better Auth,
  a cookie, a bearer token and a test fake all reduce to one function.
- **A failure is a defect, not an anonymous caller.** A slow session store cannot sign a valid
  caller out as `Unauthenticated`.
- **`asSystem` is the in-process door.** Webhooks, policies and scheduled commands do not invent a
  session they will never have.
- **`decide` never reads `Actor`.** Authorization is middleware; a model rule about state is
  `decide`.

The rest of this note is what is still weak, in the order it is worth fixing.

## Landed

### 1. The development guards now say what they are

`DevGuards`, `SessionFromHeaders` and `AdminFromHeaders` trusted a header. They are now
`InsecureDevGuards`, `InsecureSessionFromHeaders` and `InsecureAdminFromHeaders`. The old names
are removed, not aliased. The refusal's `source` is `"insecure headers"`, so a log line says which
door was used. The examples call the insecure names; a reader cannot mistake a demo
guard for a production one.

The guard is still one import away, so the rename is a warning, not a lock. A deployment that wants
a lock should provide its own `Session`/`Admin` layer and not export the insecure one.

### 2. A refusal names the boundary it crossed

`Forbidden` gained an optional `scope: "account" | "admin"`.

```ts
// SessionFrom: the actor is authenticated but the target is someone else's.
new Forbidden({ account: target, actor: actor.id, kind: actor.kind, scope: "account" });

// AdminFrom: the actor is authenticated but is not an operator.
new Forbidden({ account: actor.id, actor: actor.id, kind: actor.kind, scope: "admin" });
```

The HTTP status is the same 403, but a console or a route can now say "you are not an operator"
instead of "you may not act on this account", and a test can tell the two apart. The field is
optional so a rejection written before it still decodes.

### 3. A route that is not an Api uses the same resolver

`Paykit.authenticate(resolve)` resolves the actor for a checkout, a page or a dashboard. It is the
first half of `SessionFrom` without the target check, and it returns the same `Unauthenticated`.

```ts
const actor = yield* Paykit.authenticate(resolve)({ headers, payload: null });
const subscribe = yield* Paykit.Subscribe(actor.id);
```

Before this, `examples/auth`'s `/checkout` route called `auth.getSession()` directly and used
`session.user.id`. That was a second identity mapping, and an admin buying a tier would have bought
it for the operator's id rather than the account they meant. The helper does not decide the target;
the route still does, with `mayActOn` or a deliberate policy.

## Worth deciding next

### 4. Team accounts: one user, several billing accounts

Today `Actor.id` is both the caller and the billing account. That is right for a product where one
user is one account, and wrong for a team product: the user is `user_1`, the subscription belongs
to `org_1`, and the user is an owner of `org_1` and `org_2`. The examples work around it by mapping
`session.session.activeOrganizationId` to the account, which loses the user's own identity.

The smallest change that keeps the model honest:

```ts
export const ActorSchema = Schema.Struct({
  kind: ActorKind,
  id: Schema.String, // the caller: user_1, ops_1, paykit
  /** Accounts an `account` actor may act for. Absent means `[id]`. */
  accounts: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const mayActOn = (actor: ActorValue, accountId: string): boolean =>
  actsForAnyAccount(actor) ||
  actor.id === accountId ||
  (actor.accounts ?? []).includes(accountId);
```

This is a model decision, not a config one: `Actor.id` stops being the account id for a team
deployment, the `Forbidden` evidence gains the list, and the console's "who did this" answer
changes. It needs an ADR before code, and the `Actor` schema is a request context, not an event, so
it is additive at the wire level.

### 5. A signed session cookie, or no cookie primitive at all

`examples/admin` and `examples/tanstack` hand-roll cookies. The admin cookie is a development
identity minted by `/session`; the TanStack cookie is a demo account id. Both are unsigned, so a
browser can name any actor, and both are only acceptable because they are examples.

There are two defensible directions:

- **A `Paykit.SessionCookie` primitive.** A signed, expiring cookie that carries the actor:
  `read(headers)` verifies an HMAC and an expiry, `write(actor)` returns the `Set-Cookie` headers
  with `HttpOnly; Secure; SameSite=Lax`, and `guards()` is `SessionFrom` over it. `effect/crypto/Mac`
  already provides the HMAC and constant-time verify, and `effect/http/Cookies` provides the
  serialization. This is a session transport, not an identity provider: it stores no user record.
- **No cookie primitive.** Better Auth, Clerk and a deployment's own session service already own
  cookies; paykit should stay the resolver seam. This is the current position in `PLAN.md`, and it
  is the safer default for a library that does not want to be an auth provider.

If the primitive lands, it must sign, expire and rotate; an unsigned actor cookie is a dev guard
with a longer life, not a production session.

### 6. CSRF and the request a guard sees

`GuardRequest` is `{ headers, payload }`. It has no method and no URL, so a guard cannot check an
`Origin`, a `Referer` or a route. A `SameSite=Lax` cookie is a good mitigation for a browser API,
but a WebSocket handshake and a cross-site form are not the same shape, and the library offers no
check.

The options, cheapest first:

- **Document the boundary.** A cookie session is the deployment's, and `SameSite=Lax` + a
  same-origin JSON API is the rule. This is what the examples do today.
- **An origin option on `SessionFrom` / `AdminFrom`.** `allowOrigins` on `FromResolverOptions`;
  a request with an `Origin` outside the list is a new `CrossOrigin` rejection. This needs
  `GuardRequest` to carry the method so a safe `GET` can be exempt.
- **A `Paykit.originCheck` middleware** beside the guards, so a deployment can compose it without
  changing the resolver contract.

The second is the one that would actually close the gap. It is a small schema addition and a new
rejection, and it deserves its own slice rather than a rushed flag.

### 7. A session store is not a resolver closure

`AuthGuards` in `examples/auth` reads `PAYKIT_ADMIN_EMAILS` and captures the set when the layer is
built. A deployment that changes an operator's role must redeploy. That is acceptable for a
deployment-wide allowlist, and it is not a session store. A product that needs live roles resolves
them per request in its own `ActorResolver`; paykit should not grow a user table for it.

The same rule applies to `Admin`: it is a global operator surface. A per-account owner is not an
`Admin`; it is an `account` actor with `accounts` (decision 4), and the tenant surface is the one
that should allow it.

### 8. A surface, not a role string

`Admin` checks `actor.kind === "admin"`. That is one bit. A deployment with support, billing and
security operators will want a scope (`"billing" | "support" | "security"`) on the actor and a
guard per scope. The current answer is "compose another `RpcMiddleware` over the same resolver",
which is honest and small. It is not worth adding a role table to paykit until a second surface
exists.

## Invariants this must not break

- **`decide` stays pure.** No guard, resolver or session read reaches a model rule.
- **The Api is the unit of authorization.** A tool, a CLI command and an HTTP route reach the same
  commands with the same middleware; no surface gets a wider guard.
- **A resolver failure is a defect.** Never turn a broken session store into `Unauthenticated`.
- **An account actor is pinned to a target it may act on.** `SessionFrom` checks `mayActOn` before
  the command runs; a view's `validate` checks the key again.
- **A dev guard is named as one.** `Insecure*` is the name, `"insecure headers"` is the source, and
  no production example uses it.
- **No customer records.** The actor is an id, not a name, an email or a profile. The identity
  provider owns those.
