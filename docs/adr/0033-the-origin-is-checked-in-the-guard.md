# 0033 — The origin is checked in the guard, before the session is read

- **Status:** Accepted
- **Date:** 2026-11-08
- **Follows:** [0015](./0015-a-runtime-binding-names-a-command.md), [the auth brief](../briefs/auth.md)

## Context

[The auth brief](../briefs/auth.md) records the gap and says what would close it: an `allowOrigins`
option on the resolvers, a `CrossOrigin` refusal, and a note that it "needs `GuardRequest` to carry
the method so a safe `GET` can be exempt."

The gap is real. A paykit Api is reached with a cookie, and a cookie is exactly what a browser
attaches to a form a cross-site page posts. The session is valid, the target is the actor's own
account, and every rule the model has is satisfied — by a request the account's owner never made.

## Decision

**1. The check is in the guard, not the resolver.** `FromResolverOptions` gains `allowOrigins`, and
both `SessionFrom` and `AdminFrom` check the request's `Origin` against it **before** the resolver
runs. Refusing first matters: a request we will not honour should not read the deployment's identity
store, and a slow session lookup is not something a cross-site page should be able to spend.

**2. A request with no `Origin` is not a browser's cross-site request.** A server, a CLI and a test
send none, and refusing them would break every non-browser caller for no gain. A browser sends
`Origin` on every unsafe cross-site request, which is the case this is for.

**3. Safe methods are exempt.** `GET`, `HEAD` and `OPTIONS` cannot carry a command through a form, so
an `Origin` on one is not a CSRF vector. Everything else is checked, including a method this code has
never heard of.

**4. The method comes from the HTTP request in context, and an absent one fails closed.** The brief
assumed `GuardRequest` could carry it. It cannot: the object Alchemy hands a middleware is
`{ rpc, client, requestId, headers, payload }`, and the method is not in it — the RPC layer reads a
message, not an HTTP request. The guard therefore reads `HttpServerRequest` from context, which an
HTTP handler provides. A transport that is not HTTP, or a test that provides none, has no method; the
guard then treats the request as unsafe, so a deployment that named `allowOrigins` is never silently
unchecked.

**5. `CrossOrigin` names the origin and the method, never the actor.** The same refusal must not tell
a cross-site page whether the session it borrowed was valid, for the reason `Unauthenticated` already
gives.

**6. It is a guard error, so it reaches every RPC's channel.** `CrossOrigin` joins `Session` and
`Admin`'s error unions, `AdminReadError`, and the console's `AdminFailure`, and `httpStatus` maps it
to `403` beside `Forbidden`.

## Consequences

- A deployment that serves a browser names its origins and is done; one that does not is unchanged,
  because `allowOrigins` is opt-in and absent means "check nothing".
- The refusal happens before the session lookup, so a cross-site request costs the deployment
  nothing it has to reach.
- The check is the *browser's* rule and not a substitute for `SameSite` on the cookie: both are
  worth having, and neither makes the other redundant (a `SameSite=Lax` cookie still rides a
  top-level `POST` in some browser versions; an origin allowlist still trusts the header).
- A deployment behind a proxy that rewrites `Origin` must allow the rewritten value. Nothing here
  normalizes it, because guessing at a proxy's behaviour is how a check becomes a formality.

## Alternatives considered

- **Add `method` to `GuardRequest`.** It is the shape the brief expected, and it needs a change
  upstream in Alchemy's middleware contract — the object is built by the Api, not by paykit. Reading
  the request from context is the same fact from where it already is.
- **Check the origin in the resolver.** Every deployment would write it, and the one that forgot would
  be the one that mattered. A guard is the single place a request is authorized.
- **A `Paykit.originCheck` middleware beside the guards.** The brief's second option. It composes, and
  it also lets a deployment mount a guarded route without it, which is the failure mode this is
  meant to remove.
- **Refuse any request that carries an `Origin` at all.** It would break a same-origin browser client
  and every CORS-preflighted read.
- **A token in a header instead of the origin.** That is a CSRF token, and it is a session concern
  paykit does not own: the identity provider issues the session, so it is the one that can issue a
  double-submit token with it.

## What would reopen this

- `GuardRequest` gaining a `method` upstream: the guard would read it there and stop depending on
  `HttpServerRequest` being in context, which is the one assumption this makes.
- A deployment that needs per-route origins rather than per-guard: the option would move to the
  binding that mounts the route, and that is `Paykit.handler`'s list, not this one.
