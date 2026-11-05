# Auth example

A Worker that gates paykit with [Better Auth](https://better-auth.com). Better
Auth owns sign-up, sign-in, the session cookie and its tables on D1. paykit owns
the billing account, the catalog and the model, and never learns that Better
Auth answered.

The seam is one resolver:

```ts
const resolve: Paykit.ActorResolver = ({ headers }) =>
  auth.getSession(headers).pipe(
    Effect.map((session) =>
      session === null ? null : Paykit.actorAccount(session.user.id),
    ),
  );

const guards = Paykit.GuardsFrom(resolve);
```

`null` is an anonymous request. A failure is a defect, never `Unauthenticated`,
so a slow session store cannot sign a valid caller out. Better Auth,
[yielded/auth](https://yielded.dev/auth/), a cookie and a bearer token all
produce the same `ActorValue`, so only `src/Auth.ts` changes when the identity
provider does.

```sh
pnpm install
pnpm --filter @potion.run/example-auth test   # Better Auth's memory adapter, no account needed
pnpm --filter @potion.run/example-auth dev    # alchemy dev
```

## What is where

| File | What it declares |
| --- | --- |
| `src/Auth.ts` | Better Auth, the session-to-actor resolver, and `Paykit.GuardsFrom`. |
| `src/AuthDatabase.ts` | The D1 database Better Auth migrates at deploy. |
| `src/Billing.ts` | The catalog, the model on `MemoryStore`, and the `Manual` provider. |
| `src/catalog.ts` | Two tiers. Plain data, no provider ids. |
| `src/Worker.ts` | `/api/auth/*` for Better Auth, `/api/*` and `/admin/*` for paykit, `/checkout` for a purchase. |
| `src/Page.ts` | A one-page client for sign-up, sign-in, the session and a checkout. |
| `test/auth.test.ts` | The session maps to the account, and no cookie, another account and a non-admin are all refused. |
| `alchemy.run.ts` | Validates and records the catalog, then deploys the Worker. |

## The account is the user

`actorOf` maps a Better Auth user to `Paykit.actorAccount(session.user.id)`.
The account is never a query parameter: `/checkout?account=someone-else` still
buys for the signed-in user, because the account comes from the session.

A product where a team owns the subscription maps
`session.session.activeOrganizationId` instead. That is one function, not a
model change.

## The operator surface

`PAYKIT_ADMIN_EMAILS` is a comma-separated list of user ids or emails. Those
sessions resolve to `Paykit.actorAdmin(id)` and may reach `/admin`. Everyone
else is a tenant and gets `Forbidden` before the model runs. The list and
`AUTH_BASE_URL` are read when the stack is evaluated, so changing either is a
deploy:

```sh
PAYKIT_ADMIN_EMAILS=ops@example.com pnpm --filter @potion.run/example-auth dev
```

## Try it

```sh
# Sign up. Keep the cookie jar.
curl -c cookies.txt -X POST localhost:8787/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Example","email":"you@example.com","password":"example-password-123"}'

# Better Auth reads the session it just set.
curl -b cookies.txt localhost:8787/api/auth/get-session

# A purchase for the session's user, not for ?account=.
curl -b cookies.txt 'localhost:8787/checkout?tier=pro'

# Without the cookie the checkout is refused.
curl -i 'localhost:8787/checkout?tier=pro'
```

The tenant Api at `/api` is RPC, not REST. Use the generated client from an
app (`BillingApi.clientInProcess` or `BillingApi.layerClientHttp(url)`) or the
calls in `test/auth.test.ts`; the `/checkout` route is the REST edge this
example adds.

## Swapping Better Auth

Replace the body of `src/Auth.ts` with yielded/auth's session lookup, or with a
cookie/bearer resolver, and keep the return shape:

```ts
const guards = Paykit.GuardsFrom(({ headers }) => resolveActor(headers));
```

Nothing under `src/Billing.ts`, the catalog or the model changes. That is the
whole claim of the resolver API: authorization is middleware, and the model
never depends on which surface sent a command.
