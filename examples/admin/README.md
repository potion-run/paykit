# Admin example

A runnable Foldkit ops console for paykit. It uses `MemoryStore` and the
`Manual` provider, so it needs no database and no provider key.

```sh
pnpm --filter @potion.run/example-admin dev
pnpm --filter @potion.run/example-admin deploy
```

`alchemy.run.ts` records the catalog with `BillingStackResource`, deploys the
admin Worker, and deploys the Foldkit Website with the Worker as a service
binding. The Website Worker forwards `/session`, `/admin` and `/console` to the
admin Worker, so the app and every admin surface share one origin.

The console owns the rest of that origin: `/` is the account list and
`/accounts/:account` is one account, with the filters and the page cursor in
the query. Refreshing or pressing back keeps the view, because the URL is the
navigation state. A client-only Foldkit Website serves unmatched paths with
`index.html`, so the account paths need no extra asset config.

`POST /session` mints a development identity as a same-origin `HttpOnly`
cookie (`pk_actor`, `pk_kind`), and `src/Session.ts` reads it in the example's
`Session` and `Admin` guards. The cookie is the whole reason the Api client
connects with a WebSocket: a browser can send a cookie on a WebSocket
handshake and cannot send a header, so live reads are pushed rather than
polled. A real deployment replaces `/session` with its own sign-in, sets the
same cookie fields with `Secure`, and puts the admin hostname behind
Cloudflare Access or the equivalent.

`ChangeTier` quotes the proration on the server, asks the operator to confirm
that number, and applies it with the same request. If the amount moved between
quote and apply, the server returns a requote instead of charging a different
number.

The account list is a point-in-time read, and the panel says when it was read.
Refresh re-reads the current filter, and a confirmed write re-reads it too;
the account panel beside it is live. Open holds are read from the aggregate and
re-read when the event feed says one moved.
