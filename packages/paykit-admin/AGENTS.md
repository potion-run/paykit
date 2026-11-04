# paykit-admin

`@potion.run/paykit-admin` is a Foldkit ops console over `BillingAdminApi`.
Read [README.md](./README.md) for the mounting and deployment shape, and the
root [AGENTS.md](../../AGENTS.md) for repo rules.

## Model rules

- **The console is a client, not a second billing model.** It does not store a
  copy of the subscription aggregate, entitlement arithmetic, or proration.
  `BillingState` and `Entitlements` are the truth; `AccountEvents` is the
  history. The Model holds routes, filters, drafts, command ids, query ids and
  pending outcomes.
- **Every write is a `BillingAdmin` command with a `commandId`.** The id comes
  from `next(model.commandIds)`. A retry of `Unknown` reuses it; a new attempt
  gets a new one. Never write billing state locally on success.
- **A read has a `requestId`, not a `commandId`.** A list/preview/verify
  response is applied only while its `requestId` is the one the Model is
  waiting for.
- **The list is not live.** `ListAccounts` is a one-shot command over the
  `BillingRead` projection. Refresh it when the operator asks or after a write;
  do not turn it into a subscription or a fake view.
- **Actions are intents.** A form produces an `AdminIntent` after parsing, and
  only then becomes a command. `ChangeTier` stays disabled until a server-side
  quote/apply path makes the confirmed amount the recorded amount.
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
action and every refusal, and a contract test when `BillingAdminApi` gains a
command the console should expose. A new command that the console ignores is a
review decision, not an accident.
