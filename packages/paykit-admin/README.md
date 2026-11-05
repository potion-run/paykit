# @potion.run/paykit-admin

A Foldkit ops console for a paykit deployment. The console is a **client** of
`BillingAdminApi`; it never owns billing state. `Entitlements`, `BillingState`
and `AccountEvents` are the live reads, and every write is a command with a
command id.

## What ships

| Entry point | What it gives |
| --- | --- |
| `@potion.run/paykit-admin` | The `Console` program: `Flags`, `Model`, `init`, `update`, `subscriptions`, `view` |
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
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { FetchHttpClient } from "effect/http/FetchHttpClient";

const headers = {
  "x-paykit-actor": "ops_1",
  "x-paykit-kind": "admin",
};

const Connection = BillingAdminApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/admin`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
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

`x-paykit-actor` and `x-paykit-kind` are the development guards. A production
deployment provides its own session layer and should pass the headers its
commands and reads need. The actor shown in the console is display-only; every
authorization decision happens on the server.

Seeding `catalog` and `accounts` in `Flags` gives the console a first paint
without a round trip. A stale snapshot falls back to the live query.

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
- `pk-*` classes for the default layout, scoped under `.pk-admin`.
- `--pk-*` custom properties for colors and spacing.

Import `styles.css` once, or skip it and target the `data-*` hooks from your
own design system. The stylesheet has no global resets, fonts or icons.

## Tests

`pnpm test` covers the update loop: seeded flags, stale list responses,
opening an account, parsing an intent, one command and one pending id,
rejections, event confirmation, and retrying an `Unknown` outcome with the
same id. The Api-side read port has its own tests in
`packages/paykit/test/admin`.
