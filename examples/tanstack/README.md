# TanStack Start + Effect Atom

A TanStack Start app on Cloudflare, and the paykit Atom client as its billing
layer. The point of the example is the seam:

```ts
// src/billing.atoms.ts — the whole client declaration
export const billing = PaykitAtom.make({
  layer: Layer.mergeAll(
    catalogLayer(Catalog),
    BillingApi.layerClientHttp("/api/billing").pipe(Layer.provide(FetchHttpClient.layer)),
  ),
});
```

`make` builds one runtime over the tenant Api. From it, a page reads two views
and calls every tenant command:

```tsx
const entitlements = useAtomValue(billing.entitlements(account));
const trackUsage = useAtomSet(billing.trackUsage(account), { mode: "promise" });

await trackUsage({ feature: "messages", amount: 10, dedupeKey: crypto.randomUUID() });
// `entitlements` refreshes: the command invalidated the account's reactivity key.
```

There is no `refresh()` after a command in the page. `entitlements(account)` and
`billing(account)` register `paykit/account/<id>` with the Atom runtime, and every
successful command invalidates it. A manual refresh button is there only to show
the difference.

## The two Workers

`Cloudflare.Website.Vite` builds TanStack Start with its own `vite.config.ts` and
deploys `src/worker.ts` as the Worker entry. That entry is a two-line router:

- `/api/billing` and `/bootstrap` go to the `BillingWorker` over a service
  binding, with an `x-paykit-actor` header derived from the browser's demo
  cookie. The atom client never sends that header itself.
- Everything else goes to TanStack Start.

The same origin is what lets the browser atom client use a relative URL and a
cookie. There is no CORS and no public billing URL. The `runWorkerFirst` list in
`alchemy.run.ts` is what sends those paths to the Worker instead of the asset
router.

## Why there is no `subscribe` atom

A subscription is an **operation**, not a tenant command: it walks the provider's
checkout or invoice path and only the process that owns the provider can do it.
`PaykitAtom` therefore exposes the tenant bindings (`trackUsage`, `hold`,
`settleHold`, `releaseHold`, `consumeCredits`, `scheduleCancellation`, `resume`,
`scheduleTierChange`, `withdrawTierChange`, `startTrial`, `check`), and the
example's one purchase-ish path is `POST /bootstrap` in the Billing Worker. The
page calls it once, then everything else is an atom.

That is the same line `BillingApiLayer` draws: the browser gets the commands the
Api serves, and the deployment owns the operations the model's process owns.

## Files

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Two tiers. Plain data, shared by the Worker and the browser. |
| `src/Billing.ts` | The model on `MemoryStore`, the `Manual` provider, and `InsecureDevGuards`. |
| `src/BillingWorker.ts` | `/api/*` for the tenant Api, `/bootstrap` for the free tier. |
| `src/worker.ts` | The Website entry: proxy billing paths, hand the rest to TanStack. |
| `src/billing.atoms.ts` | `PaykitAtom.make` over the Api client and the catalog. |
| `src/routes/index.tsx` | The page: bootstrap, read, track, check, cancel, resume. |
| `src/session.ts` | The demo cookie and actor header, shared by both entries. |
| `test/example.test.ts` | The catalog, and the operation the bootstrap calls. |
| `alchemy.run.ts` | Deploys the Billing Worker and the TanStack website. |

## Run it

```sh
pnpm install
pnpm --filter @potion.run/example-tanstack test
pnpm --filter @potion.run/example-tanstack dev
```

The Billing Worker runs on Durable Objects, so a usage fact survives the next
request. No provider key is needed: `Manual()` sells through an invoice, and the
bootstrap only uses the free tier.

## What a real deployment changes

Two files, not the atom client:

- `src/session.ts` and `src/worker.ts`: resolve the actor from the deployment's
  own session (Better Auth, yielded/auth, a bearer token) and set the header from
  that session instead of a cookie the demo mints. `examples/auth` is the
  `GuardsFrom` version of this seam.
- `src/Billing.ts`: swap `MemoryStore` for `Paykit.SqlAggregateStore` over D1, and
  `Manual()` for `Polar(...)` or `Stripe(...)`.

The catalog, the model, the atom declarations and every command atom stay as
they are.
