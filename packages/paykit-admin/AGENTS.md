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
  an account keeps both.
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
- **Holds are entities, so they are read as entities.** The allowance table
  folds a hold into a `reserved` count; the holds panel reads the aggregate's
  holds through `AdminReads.holds` and re-reads them when the feed reports
  `UsageReserved`, `UsageSettled` or `UsageReleased`. It is a stamped snapshot
  like the list, not a subscription.
- **A preview is a question, not a write.** `Preview` runs the same `decide` a
  command runs and records nothing, so it allocates no command id and never
  touches `pending`. The console's answers are `accepted`, `rejected` or
  `unpredictable`; render exactly what came back.
- **Serve it through `AdminConsoleServer`.** It captures the `Admin` middleware
  the way `Domain.Api` captures an API's middleware. Do not hand-merge the RPC
  handler, serialization and auth layers.
- **Actions are intents.** A form produces an `AdminIntent` after parsing, and
  only then becomes a command.
- **A tier change is a quote, then an apply.** The server computes the
  proration and applies only the amount the operator confirmed. A mismatch is
  a requote, never a silently different charge. Do not send `BillingAdmin`'s
  raw `ChangeTier` from the console.
- **No generic schema forms.** Command payloads carry `allowances`, `price` and
  `proration` that an operator must never type. The catalog is the source for
  tier data; the server decides the rest.
- **No customer records.** The console shows account ids. A host that wants a
  name or email joins its own directory; paykit must not start storing one.

## UI rules

- Compose `@foldkit/ui` only for behavior the repo already ships. This package
  does not reimplement focus traps, popovers or menus. Button, Input, Select
  and Textarea are the components the console composes; a new control needs a
  component that exists, not a local copy of its ARIA and keyboard behavior.
- The local `src/ui` kit is the shadcn layer, ported from the yaka component
  kit. Button, Card, Table, Input, Select, Textarea, Field, Badge, Alert, Empty
  and Tabs live there. New UI imports the kit; it does not hand-roll a second
  button, field or table.
- Style from the shadcn tokens (`--pk-background`, `--pk-foreground`,
  `--pk-card`, `--pk-primary`, `--pk-muted-foreground`, `--pk-border`,
  `--pk-ring`, and the semantic status tokens). Do not add raw colors to a
  component. The dark set is selected by `prefers-color-scheme`.
- The local event lab is a development surface. It is enabled only through
  `Flags.devTools`, every dev-tools Message is inert while that flag is false,
  and it emits simulated events through the same `recordEvent` path the live
  feed uses. It never calls the Api and never becomes a second write path.
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
not an accident. Every action the console offers is checked against
`Subscription.predict` by a property test in `packages/paykit/test/admin`.
