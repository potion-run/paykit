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
| `@potion.run/paykit-admin/ui` | The shadcn component kit: Button, Card, Table, Input, Select, Textarea, Field, Badge, Alert, Empty and Tabs |
| `@potion.run/paykit-admin/DevTools` | The event table, tab list, `DevToolsState` schema and seed helpers behind the floating **Paykit dev tools** panel |
| `@potion.run/paykit-admin/styles.css` | Optional default styles, scoped to `.pk-admin` |

The console covers the account list, the standing and allowance panels, the
period's priced usage, open holds with their deadlines, the billing timeline
folded from the event feed, and the account event feed. Two read-only pages
list the deploy's `Plans` and `Features` from the catalog the console already
holds.

The account page offers these actions: `GrantCredits`, `ExtendTrial`,
`ChangeTier`, `EnterGrace`, `RecordPayment`, `RecordPaymentFailure`, `Recover`,
`Expire`, `ScheduleCancellation` and `Resume`.

Two panels ask questions instead of writing: **Ask the model** runs `Preview` —
the same `decide` a write runs — and shows the events it would record or the
rejection that stops it; **Verify** judges the standing against the deploy's
catalog and provider. Neither allocates a command id, because neither is a
write.

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
| `/?after=acct_50` | The next page, by the cursor the previous one returned |
| `/accounts/:account` | One account, with the list's filters and page preserved |
| `/plans` | The deploy's tiers, read only |
| `/features` | The deploy's features, read only |

`Console.routing` turns a URL change into `ChangedUrl` and a link click into
`ClickedLink`; spreading `Console` into `Runtime.makeApplication` brings it
along. A navigation command reflects the route through `reflectRoute`, and
`init` parses the same string back through `routeOf`, so the Model follows the
URL rather than the other way round. Selecting another account drops the
previous account's state, which is what restarts its live reads under the new
key: nothing from the account you left survives into the one you opened. The
page cursor is in the URL too, so a refresh keeps the page and back walks it;
changing a filter drops the cursor, because a cursor from another filter names
a row that filter may not have.

Run the app on its own origin (`/`, `/accounts/...`, `/plans` and
`/features` are the console's paths), and keep `/admin` and `/console` for the
Api and read surfaces.

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

**Open holds** are the entities the allowance table folds into `reserved`
counts, so they come from the aggregate through `AdminReads.holds`, once when
the account opens and again when the event feed says a hold moved
(`UsageReserved`, `UsageSettled`, `UsageReleased`). That panel says when it was
read too; it shows the held-at and expiry times rather than a computed age.

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

## Test it without a server

The console can carry its own event lab. Set `Flags.devTools` and a floating
trigger appears in the bottom-right corner, shaped like rat-stack's devtools.
The panel has three tabs:

- **Events** — a table of every event the `Subscription` aggregate can record.
  Click a row to load its payload, then **Emit selected** or **Emit every
event**. The payload is display-only; the console never decodes it.
- **Reads** — open an account the deployment does not have, seed its standing,
  allowances and holds, or fail its reads.
- **Feed** — catch up, fail the feed, or reset the lab.

It is local only: the event lab never calls `BillingAdminApi`, and the server
remains the source of truth.

```ts
Console.Flags.make({
  session: crypto.randomUUID(),
  actor: { id: "ops_1", kind: "admin" },
  devTools: import.meta.env.DEV,
});
```

The event table is checked against `Subscription.definition.events` by a
coverage test, so the lab cannot silently miss an event the aggregate adds.
With no account open, **Emit selected** and **Emit every event** open the lab
account and seed it before recording; the **Reads** tab can open and seed any
other account the deployment does not have.

The panel is off by default, and every message it can dispatch is inert while
`Flags.devTools` is false, so a deployed console cannot be coaxed into fake
reads. Keep it opt-in per environment.

The components come from `@foldkit/ui`: `Button`, `Input`, `Textarea` and
`Select` supply the behavior and ARIA wiring, and the package adds only the
`pk-*` layout classes.

## Foldkit DevTools

[Foldkit DevTools](https://foldkit.dev/core/devtools) is a separate overlay: a
timeline of every Message, the Model at each step, and time travel. The Vite
plugin mounts it in development when the package is installed. Pass the
console's `Message` schema so the DevTools MCP server can dispatch one:

```ts
Runtime.makeApplication({
  ...Console,
  resources,
  container: document.getElementById("root"),
  devTools: {
    // Keep the official badge and panel on the left; the event lab's
    // floating trigger owns the bottom-right corner.
    position: "BottomLeft",
    mode: { development: "TimeTravel", production: "Inspect" },
    Message: Console.Message,
  },
});
```

`@foldkit/devtools` belongs in `devDependencies`; production builds leave the
overlay out. The in-app event lab is what an operator sees, and the Foldkit
overlay is what a developer sees: every event-lab Message is recorded in the
overlay's timeline, so the lab can produce the events and DevTools can explain
what they did to the Model.

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

A browser cannot set headers on a WebSocket, so a header guard cannot carry a
session into pushed live reads. Authenticate with a same-origin `HttpOnly`
cookie instead, serve the live reads over a WebSocket, and send no header
config at all. `examples/admin` does exactly this: it mints the cookie at
`/session` (a development identity), reads it in its `Session` and `Admin`
guards, and connects with a WebSocket.

```ts
// Server: resolve the actor from the session cookie your host already sets,
// then provide it as `Session` and `Admin` exactly as DevGuards does with
// headers. The cookies are HttpOnly, SameSite=Lax, scoped to the admin origin,
// and written as one Set-Cookie header per cookie.
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
WebSocket handshake, so `CommandHeaders` is not needed. Mint it over HTTPS with
`Secure` alongside `HttpOnly` and `SameSite=Lax`. Two consequences worth
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

The package ships headless state hooks, a shadcn component kit and an optional
stylesheet:

- `@potion.run/paykit-admin/ui` exposes the common components: `Button`,
  `Card`, `Table`, `Input`, `Select`, `Textarea`, `Field`, `Badge`, `Alert`,
  `Empty` and `Tabs`. They are ported from the yaka shadcn/Foldkit kit and
  rebuilt against the plain `pk-*` stylesheet. Import a single module
  (`.../ui/button`) or the namespace (`.../ui`).
- Behavior comes from `@foldkit/ui` — focus, disabled, invalid and label
  wiring — and the kit supplies the shadcn markup and classes.
- `data-paykit-standing`, `data-paykit-status`, `data-paykit-feed`,
  `data-paykit-pending` for state.
- `data-paykit-consistency="snapshot"` and `data-paykit-as-of` (an ISO time, or
  `unknown`) on the account list, so a host's own styles can mark the list as a
  point-in-time read.
- `pk-*` classes for the default layout, scoped under `.pk-admin`.
- `--pk-*` custom properties for the shadcn theme. The defaults are shadcn's
  Blue preset over the Neutral base (`--pk-background`, `--pk-foreground`,
  `--pk-card`, `--pk-primary`, `--pk-muted`, `--pk-destructive`, `--pk-border`,
  `--pk-input`, `--pk-ring`), with a dark set selected by
  `prefers-color-scheme`.

New UI composes the kit and the tokens rather than adding raw colors or
one-off button, card, table or field markup. Import `styles.css` once, or skip
it and target the `data-*` hooks from your own design system. The stylesheet
has no global resets, fonts or icons.

## Tests

`pnpm test` covers the update loop: seeding the first paint from Flags and the
URL, a snapshot that no longer decodes, opening an account from the route,
following a reflected URL and a back button, the page cursor in the URL and its
re-read after a write, one list read per filter change, the list's read stamp,
stale list and holds responses, opening an account's holds and re-reading them
when the feed says one moved, a preview that allocates no command id and
ignores a stale answer, verification, parsing an intent, one command and one
pending id, rejections, event confirmation, and retrying an `Unknown` outcome
with the same id. The event lab has its own suite: every aggregate event is in
its table, the table is inert without `Flags.devTools`, an emission takes the
next sequence and moves the feed, and the seed produces a consistent standing,
allowances and holds. The Api-side read port has its own tests in
`packages/paykit/test/admin`, including a property test that every action
`actionsFor` offers is one `Subscription.predict` accepts, and a test that
`holds` returns the entities the views fold into `reserved`.
