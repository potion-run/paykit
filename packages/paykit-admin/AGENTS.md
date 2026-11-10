# paykit-admin

`@potion.run/paykit-admin` is a Foldkit ops console over `BillingAdminApi`.
Read [README.md](./README.md) for the mounting and deployment shape, and the
root [AGENTS.md](../../AGENTS.md) for repo rules.

## Model rules

- **The console is a client, not a second billing model.** It does not store a
  copy of the subscription aggregate, entitlement arithmetic, or proration.
  `BillingState` and `Entitlements` are the truth; `AccountEvents` is the
  history. The Model holds routes, filters, drafts, command ids, query ids,
  read stamps and pending outcomes.
- **The URL is the navigation state.** The route names the account, the
  filters and the page cursor (`/accounts/:account`, `?standing=grace`,
  `?after=acct_50`); a navigation change is reflected with `reflectRoute` and
  re-parsed with `routeOf`. Never keep a selection the URL cannot reproduce.
  Applying a route naming another account replaces the account state, which is
  what restarts its keyed reads. A filter change drops the page cursor; opening
  an account keeps both. `/overview` is a cross-account read, and `/plans` and
  `/features` are read-only catalog pages; the last three name no account and
  carry no list filter or page cursor.
- **A seeded snapshot is the first frame of a live read, not a second source.**
  `Flags` carries wire-encoded snapshots decoded by `decodeSnapshotFlags`; a
  snapshot that no longer decodes falls back to the live read. A seeded account
  starts `CatchingUp` and resumes its event stream after its cursor.
- **Every write is a `BillingAdmin` command with a `commandId`.** The id comes
  from `next(model.commandIds)`. A retry of `Unknown` reuses it; a new attempt
  gets a new one. Never write billing state locally on success.
- **Keep the evidence.** A pending command stores the typed `AdminFailure`
  (`Rejected`, `Denied`, `Unknown`), not only its tag or a message string, so an
  operator can see `DowngradeBelowUsage`'s feature and numbers. Transport
  failures keep the RPC reason tag as well as the message.
- **A read has a `requestId`, not a `commandId`.** A list/preview/verify
  response is applied only while its `requestId` is the one the Model is
  waiting for.
- **The list is not live.** `ListAccounts` is a one-shot command over the
  `BillingRead` projection. Its page carries the time the store answered
  (`asOf`); the panel always says when the rows were read or that the read time
  is unknown, and never presents them as live. Re-read it when the operator
  asks, when a filter or page changes, or after the console's own write lands.
- **The overview is one aggregate read, not a second billing model.**
  `AdminReads.overview` pages the `BillingRead` projection and derives MRR,
  ARR, at-risk and trial-pipeline totals from the catalog's prices. The view
  merges local devtools rows into that aggregate only for display; it never
  writes those rows or presents the projection as live.
- **Holds are entities, so they are read as entities.** The allowance table
  folds a hold into a `reserved` count; the holds panel reads the aggregate's
  holds through `AdminReads.holds` and re-reads them when the feed reports
  `UsageReserved`, `UsageSettled` or `UsageReleased`. It is a stamped snapshot
  like the list, not a subscription, and it shows settled and released history
  beside the open rows.
- **Provider refs are a separate read.** The panel reads
  `AdminReads.providerRefs` once when the account opens and again on
  `ProviderRefAttached`; the ids stay grouped by provider. They are never
  inferred from the feed body or stored in the Model as billing state.
- **A preview is a question, not a write.** `Preview` runs the same `decide` a
  command runs and records nothing, so it allocates no command id and never
  touches `pending`. The console's answers are `accepted`, `rejected` or
  `unpredictable`; render exactly what came back.
- **Serve it through `AdminConsoleServer`.** It captures the `Admin` middleware
  the way `Domain.Api` captures an API's middleware. Do not hand-merge the RPC
  handler, serialization and auth layers.
- **Actions are intents.** A form produces an `AdminIntent` after parsing, and
  only then becomes a command.
- **A refund is a console RPC, not an Api command.** It moves money through the
  provider, so `AdminConsoleRpcs.Refund` runs the in-process binding on the
  Worker that owns the provider; `BillingAdminApi` has no refund. The console
  offers it while `charged - refunded` is positive in a currency, even after a
  terminal standing, because a refund is money rather than a move on the
  standing. Its command id is the provider's idempotency key; a retry after an
  unknown outcome reuses it. Keep the typed rejection as `RpcRejected`, not a
  message string.
- **A reversal is an Api command, because it needs no provider.** `ReverseRefund`
  is the one money action the operator Api serves: the provider already returned
  the money, so there is nothing to call. It is offered per refund row while
  `amount - reversed` is positive — not per phase, and not from the per-currency
  total — and the row passes the refund and its outstanding amount into
  `draftWith`, so an operator never retypes an id the page is showing.
- **A tier change is a quote, then an apply.** The server computes the
  proration and applies only the amount the operator confirmed. A mismatch is
  a requote, never a silently different charge. Do not send `BillingAdmin`'s
  raw `ChangeTier` from the console.
- **No generic schema forms.** Command payloads carry `allowances`, `price` and
  `proration` that an operator must never type. The catalog is the source for
  tier data; the server decides the rest.
- **The console renders the customer record, and never invents one.**
  `BillingStateView.customer` carries the name and email a `CreateCustomer`
  recorded (ADR 0045); the console renders that field and stores no identity of
  its own. The list reads `BillingReadRow.customer` for the name and email, and
  searches the account id, name and email through the list query.
- **Credits are counts, not money.** `BillingStateView.credits` is a pool of
  credits. Render it with a unit (`formatCredits`), never with `formatMoney`; a
  pool of 4,820 credits is not $48.20. The same rule applies to the
  `GrantCredits` form, whose amount is a credit count.
- **One status for the operator.** `status`, `standing` and
  `cancelAtPeriodEnd` are separate machines. Collapse them into one pill and a
  sentence that says why: past due, suspended, canceling, trial or active.
  Keep the raw `data-paykit-status` and `data-paykit-standing` hooks for tests;
  do not render the raw words as a second badge.
- **The overview's attention list is server-wide.** Render
  `BillingOverview.attention` / `attentionCount`; never filter the loaded list
  page and call it the deployment. The list is a page, the overview is the
  cross-account read.
- **The first screen is the operator's five questions.** Identity, plan, status,
  usage and the next action stay above the fold. Holds, provider IDs, raw
  events, preview and verify belong in a disclosure or the Developer section.

## UI rules

- Compose `@foldkit/ui` only for behavior the repo already ships. This package
  does not reimplement focus traps, popovers or menus. Button, Input, Select
  and Textarea are the components the console composes; a new control needs a
  component that exists, not a local copy of its ARIA and keyboard behavior.
- The local `src/ui` kit is the shadcn layer, ported from the yaka component
  kit. Button, Card, Table, Input, Select, Textarea, Field, Badge, Alert, Empty,
  Tabs, the static `MiniBars` strip and the `PieChart` donut live there. New
  UI imports the kit; it does not hand-roll a second button, field or table.
- Style from the shadcn tokens (`--pk-background`, `--pk-foreground`,
  `--pk-card`, `--pk-primary`, `--pk-muted-foreground`, `--pk-border`,
  `--pk-ring`, and the semantic status tokens). Do not add raw colors to a
  component. The dark set is selected by `prefers-color-scheme`.
- The local event lab is a development surface. It is enabled only through
  `Flags.devTools`, every dev-tools Message is inert while that flag is false,
  and it emits simulated events through the same `recordEvent` path the live
  feed uses. A lab payload is decoded to its aggregate event before that call,
  so emitted events fold into the timeline instead of staying display-only.
  The Reads tab can seed one configured account or a varied local set; those
  rows appear in the list and overview overlay, never in the server projection.
  It never calls the Api and never becomes a second write path.
  It is a floating trigger and a tabbed panel in the
  [rat-stack](https://github.com/joelhooks/rat-stack/tree/main) shape, not a
  section in the console layout, so the operator's page stays the page.
- State is a discriminated union, not booleans. A pending command has a status
  (`Sending`, `Unknown`, `Accepted`, `Rejected`, `Denied`), an intent and a
  reason.
- Money is integer minor units. Format at the view edge; never do money math
  in the Model.
- The stylesheet is optional. Keep `data-paykit-*` hooks stable and add
  classes rather than renaming existing ones.
- The package owns no global CSS, fonts, icons or time zone policy. The host
  seeds the actor, catalog and snapshots in Flags.

## Tests

`pnpm test` runs the update loop without a browser. Add a story for every
action and every refusal, a route test for every navigation the console can
start, and a contract test when `BillingAdminApi` gains a command the console
should expose. A new command that the console ignores is a review decision,
not an accident. Every standing action the console offers is checked against
`Subscription.predict` by a property test in `packages/paykit/test/admin`.
`Refund` is the exception: it is not a command on the standing, and its ceiling
is the refund binding's, checked by `test/admin/RefundRpc.test.ts`.
