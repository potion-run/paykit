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
- **The URL is the navigation state.** The route names the account and the
  filters (`/accounts/:account`, `?standing=grace`); a navigation change is
  reflected with `reflectRoute` and re-parsed with `routeOf`. Never keep a
  selection the URL cannot reproduce. Applying a route naming another account
  replaces the account state, which is what restarts its keyed reads.
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
  asks, when a filter changes, or after the console's own write lands.
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
  does not reimplement focus traps, popovers or menus.
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
