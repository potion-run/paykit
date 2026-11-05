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

`POST /session` mints a development identity as two same-origin `HttpOnly`
cookies (`pk_actor`, `pk_kind`), and `src/Session.ts` reads them in the example's
`Session` and `Admin` guards. They are written as two `Set-Cookie` headers,
not one combined header: a browser stores only the first name=value pair in a
combined header, which would silently leave the actor looking like an account
and produce `Forbidden` on the admin reads. The cookies are the whole reason
the Api client connects with a WebSocket: a browser can send cookies on a
WebSocket handshake and cannot send a header, so live reads are pushed rather
than polled. A real deployment replaces `/session` with its own sign-in, sets
the same cookie fields with `Secure`, and puts the admin hostname behind
Cloudflare Access or the equivalent.

`ChangeTier` quotes the proration on the server, asks the operator to confirm
that number, and applies it with the same request. If the amount moved between
quote and apply, the server returns a requote instead of charging a different
number.

The account list is a point-in-time read, and the panel says when it was read.
Refresh re-reads the current filter, and a confirmed write re-reads it too;
the account panel beside it is live. Open holds are read from the aggregate and
re-read when the event feed says one moved.

## Dev tools

Two tools sit beside the app in development.

- **The event lab** is inside the console. It is enabled by
  `Flags.devTools: import.meta.env.DEV`, and its floating bottom-right trigger
  opens a panel with **Events**, **Reads** and **Feed** tabs. It emits every
  event in `Subscription.definition.events`, seeds a standing and open holds,
  and simulates a failed feed or read. It never calls the server, so it is how
  the console is exercised when the local store is empty. The shape follows
  [rat-stack's devtools](https://github.com/joelhooks/rat-stack/tree/main), and
  the console's shadcn theme is carried through to the panel.
- **`@foldkit/devtools`** is the
  [Foldkit DevTools overlay](https://foldkit.dev/core/devtools): every Message,
  the Model at each step, and time travel. It is a development dependency, so
  the Vite plugin injects it during `pnpm dev` and leaves it out of the
  production bundle. `src/entry.ts` passes `Console.Message` so the DevTools MCP
  server can dispatch a Message into the console, and puts the official badge
  on the bottom-left so the event lab owns the bottom-right.
