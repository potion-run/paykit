# Admin example

A runnable Foldkit ops console for paykit. It uses `MemoryStore` and the
`Manual` provider, so it needs no database and no provider key.

```sh
pnpm --filter @potion.run/example-admin dev
pnpm --filter @potion.run/example-admin deploy
```

`alchemy.run.ts` records the catalog with `BillingStackResource`, deploys the
admin Worker, and deploys the Foldkit Website with the Worker as a service
binding. The Website Worker forwards `/admin` and `/console` to the admin
Worker, so the app and both admin surfaces share one origin.

The browser sends `x-paykit-actor: ops_1` and `x-paykit-kind: admin`, which
`DevGuards` accepts. That is a development guard: a real deployment replaces it
with its own session and CSRF headers, and should put the admin hostname behind
Cloudflare Access or the equivalent.

Because a browser cannot set headers on a WebSocket, the example uses
`Domain.protocolHttp` for the admin Api so live reads carry the same headers as
commands. A production app with a cookie session can switch to
`Domain.protocolWebSocket` and get pushed reads.

`ChangeTier` quotes the proration on the server, asks the operator to confirm
that number, and applies it with the same request. If the amount moved between
quote and apply, the server returns a requote instead of charging a different
number.
