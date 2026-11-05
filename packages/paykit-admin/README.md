# @potion.run/paykit-admin

A Foldkit ops console for a paykit deployment. The console is a **client** of
`BillingAdminApi`; it never owns billing state. `Entitlements`, `BillingState`
and `AccountEvents` are the live reads, and every write is a command with a
command id.

## What ships

| Entry point | What it gives |
| --- | --- |
| `@potion.run/paykit-admin` | The `Console` program: `Flags`, `Model`, `init`, `update`, `subscriptions`, `routing`, `view` |
| `@potion.run/paykit-admin/Console` | The same program from its own module |
| `@potion.run/paykit-admin/styles.css` | Optional default styles, scoped to `.pk-admin` |

The console's first release covers the account list, the standing and
allowance panels, the account event feed, and these actions: `GrantCredits`,
`ExtendTrial`, `ChangeTier`, `EnterGrace`, `RecordPayment`,
`RecordPaymentFailure`, `Recover`, `Expire`, `ScheduleCancellation` and
`Resume`.

`ChangeTier` is a two-step quote/apply: the server computes the proration with
its own clock, the operator confirms that amount, and the server applies only
if the recomputed amount still matches. A stale quote comes back as a requote,
never as a different charge.

The console shows account ids and billing state only. paykit stores no customer
records, so there is no name, email or profile to show.

## Where you are lives in the URL

The address bar is the navigation state, so a refresh, a shared link and a back
button all land on the same view:

| URL | View |
| --- | --- |
| `/` | The account list, unfiltered |
| `/?standing=grace&tier=pro` | The list, filtered |
| `/accounts/:account` | One account, with the list's filters preserved |

`Console.routing` turns a URL change into `ChangedUrl` and a link click into
`ClickedLink`; spreading `Console` into `Runtime.makeApplication` brings it
along. A navigation command reflects the route through `reflectRoute`, and
`init` parses the same string back through `routeOf`, so the Model follows the
URL rather than the other way round. Selecting another account drops the
previous account's state, which is what restarts its live reads under the new
key: nothing from the account you left survives into the one you opened.

Run the app on its own origin (`/` and `/accounts/...` are the console's
paths), and keep `/admin` and `/console` for the Api and read surfaces.

## The list is a point-in-time read

`ListAccounts` is a one-shot command over the `BillingRead` projection, not a
subscription. `List` stamps every page with the time it answered (`asOf`), and
the panel always says when the rows were read — or that the read time is
unknown, when a hand-built snapshot carried no stamp. It never presents the
list as live.

- **Refresh** re-reads the current filter, keeping the rows on screen and
  labelling the panel as refreshing.
- **A confirmed write** re-reads the list, because the row the operator just
  changed (tier, standing, credits) is the one the snapshot has wrong.
- **The account panel** is live: `Entitlements`, `BillingState` and
  `AccountEvents` are watches, so only the list needs the label.

## Seed the first paint

`Flags` may carry three snapshots, each wire-encoded and decoded by
`decodeSnapshotFlags`. A snapshot the current schema no longer matches is
dropped and the live read fills the panel; a stale deployment costs a round
trip, never boot.

```ts
import { AccountSnapshot, Console } from "@potion.run/paykit-admin";

// On the server, for the request's URL: read the catalog, one page of the list
// for the route's filters, and — when the route names an account — that
// account's billing, entitlements and event cursor.
const snapshots = {
  catalog: Schema.encodeSync(Catalog)(catalog),
  accounts: Schema.encodeSync(BillingReadPage)(page),
  account: Schema.encodeSync(AccountSnapshot)({
    account: "acct_1",
    billing,
    entitlements,
    cursor: lastSeq,
  }),
};

// In the browser, at boot.
Runtime.run(
  Runtime.makeApplication({
    ...Console,
    resources,
    container: document.getElementById("root"),
  }),
  { flags: Console.Flags.make({ session: crypto.randomUUID(), ...snapshots }) },
);
```

A seeded list must answer the filters in the page's URL; a seeded account is
used only when the route selects that account. The seeded account starts with
`feed: "CatchingUp"` and resumes its event stream after `cursor`, so it is the
first frame of the live reads rather than a claim that nothing has happened
since.

The console is client-only: it ships no server entry, and snapshots are how a
host buys a first paint. A server-rendered first paint would need the host's
own entry beside `Cloudflare.Website.Foldkit`'s generated one, which is out of
scope for this package.

## Mount it

`Console` is a normal Foldkit application. The host provides the
`BillingAdminApi` client and the `Admin` read port as resources:

```ts
import * as Domain from "@alchemy.run/domain";
import { BillingAdminApi } from "@potion.run/paykit";
import { AdminReadsClient } from "@potion.run/paykit/Admin";
import { CommandHeaders } from "@potion.run/paykit/Foldkit";
import { Console } from "@potion.run/paykit-admin";
import "@potion.run/paykit-admin/styles.css";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";
import { FetchHttpClient } from "effect/http/FetchHttpClient";

const headers = {
  "x-paykit-actor": "ops_1",
  "x-paykit-kind": "admin",
};

// The development guard reads headers, and a browser cannot set headers on a
// WebSocket. `protocolHttp` carries the header pair on every call.
const Connection = BillingAdminApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp(`${location.origin}/admin`)),
);

const resources = Layer.mergeAll(
  Connection,
  AdminReadsClient(`${location.origin}/console`, { headers }),
  Layer.succeed(CommandHeaders, {
    get: () => Effect.succeed(headers),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    ...Console,
    resources,
    container: document.getElementById("root"),
  }),
  {
    flags: Console.Flags.make({
      session: crypto.randomUUID(),
      actor: { id: "ops_1", kind: "admin" },
    }),
  },
);
```

`x-paykit-actor` and `x-paykit-kind` are the development guards; a production
deployment replaces them with a cookie session and WebSocket live reads (see
[A production session](#a-production-session)). The actor shown in the console
is display-only; every authorization decision happens on the server.

## A production session

The development example authenticates with headers, and a browser cannot set
headers on a WebSocket: that is the only reason it uses `protocolHttp` for
commands. A production host should use a same-origin `HttpOnly` cookie instead,
serve the live reads over a WebSocket, and send no header config at all.

```ts
// Server: resolve the actor from the session cookie your host already sets,
// then provide it as `Session` and `Admin` exactly as DevGuards does with
// headers. The cookie is HttpOnly, SameSite=Lax, and scoped to the admin origin.
const Connection = BillingAdminApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/admin`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

const resources = Layer.mergeAll(
  Connection,
  AdminReadsClient(`${location.origin}/console`),
  AdminChangeTierClient(`${location.origin}/console`),
).pipe(Layer.provide(FetchHttpClient.layer));
```

A cookie is sent by the browser on `fetch`, on the RPC HTTP calls and on the
WebSocket handshake, so `CommandHeaders` is not needed. Two consequences worth
keeping: the guards must still check the cookie's actor kind on the server
(the console's actor is display-only), and a same-site cookie plus the
same-origin check is what stands in for the CSRF token the header pair gave
you.

## Serve the reads beside the admin Api

The account list spans keys, so it is not a Domain Api read. `AdminReadsRpcs`
is an Effect RPC group with the same `Admin` middleware as the admin
commands, and `AdminChangeTierRpcs` adds the tier-change write. Both are
merged into `AdminConsoleRpcs`.

`AdminConsoleServer` builds the Worker handler from the hosted model and
captures the host’s middleware context once, the way `Domain.Api` serves an
Api. A custom `Admin` layer or session service therefore cannot be dropped by
forgetting a layer:

```ts
import { AdminConsoleServer } from "@potion.run/paykit/Admin";

const admin = yield* BillingAdminApi;
const console = yield* AdminConsoleServer;

fetch: Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const path = new URL(request.url, "http://localhost").pathname;
  if (path.startsWith("/console")) return yield* console;
  if (path.startsWith("/admin")) return yield* admin.fetch;
  return HttpServerResponse.text("Not Found", { status: 404 });
});
```

Provide the hosted model’s `BillingReadStore`, `CatalogService`, `Subscription`
and `Admin` guard while building `AdminConsoleServer`. The example’s
`BillingLayers` does exactly that. Serve the app and both surfaces on one
origin, so the session cookie reaches commands and WebSocket live reads.

## Deploy with Alchemy

Keep the console a normal `Cloudflare.Website.Foldkit` resource. It is an app,
not a paykit resource.

```ts
const billingWorker = yield* BillingWorker;

const admin = yield* Cloudflare.Website.Foldkit("PaykitAdmin", {
  rootDir: "apps/admin",
  main: "src/worker.ts",
  env: { BILLING: billingWorker },
  assets: {
    runWorkerFirst: ["/admin", "/admin/*", "/console", "/console/*"],
  },
});
```

```ts
export default {
  fetch(request: Request, env: { ASSETS: Fetcher; BILLING: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/admin") || pathname.startsWith("/console")
      ? env.BILLING.fetch(request)
      : env.ASSETS.fetch(request);
  },
};
```

Put the admin hostname behind Cloudflare Access or the equivalent. The console
is an internal tool, and its `Admin` guard is only as strong as the session
layer behind it.

## Styling

The package ships headless state hooks and an optional stylesheet:

- `data-paykit-standing`, `data-paykit-status`, `data-paykit-feed`,
  `data-paykit-pending` for state.
- `data-paykit-consistency="snapshot"` and `data-paykit-as-of` (an ISO time, or
  `unknown`) on the account list, so a host's own styles can mark the list as a
  point-in-time read.
- `pk-*` classes for the default layout, scoped under `.pk-admin`.
- `--pk-*` custom properties for colors and spacing.

Import `styles.css` once, or skip it and target the `data-*` hooks from your
own design system. The stylesheet has no global resets, fonts or icons.

## Tests

`pnpm test` covers the update loop: seeding the first paint from Flags and the
URL, a snapshot that no longer decodes, opening an account from the route,
following a reflected URL and a back button, one list read per filter change,
the list's read stamp and its re-read after a write, stale list responses,
parsing an intent, one command and one pending id, rejections, event
confirmation, and retrying an `Unknown` outcome with the same id. The
Api-side read port has its own tests in `packages/paykit/test/admin`, including
a property test that every action `actionsFor` offers is one
`Subscription.predict` accepts.
