# 0049 — The billing schema is a description, and the deploy converges it

- **Status:** Accepted
- **Date:** 2026-11-15
- **Follows:** [0003](./0003-the-deploy-provisions-the-vendor.md), [0047](./0047-a-plan-is-versioned-and-a-move-is-its-migration.md)

## Context

Paykit stores its event log, receipts, state, outbox, schedules and read models in SQL, and it now
has three targets: SQLite under Bun for development and tests, D1 in a Cloudflare Worker, and
Postgres through Hyperdrive, Neon, Aurora or a plain connection, and MySQL. The DDL is rendered from
a typed description, but every target applied it differently: the billing example handed a directory
to the D1 resource, and the Postgres example carried its own `MigrateBilling` Action that built a
`pg` client and ran Alchemy's registry. Nothing connected those mechanisms, and nothing noticed when
a deploy should re-run one.

Three structural facts make this a decision rather than a cleanup.

**Runtime access and migration access cannot be one connection.** Hyperdrive's connection string
only exists inside the Worker, so the deploy cannot use it. A migration needs one dedicated session:
the registry's bookkeeping queries are unqualified, so Postgres needs `search_path` scoped and
restored around them, and a pooled connection spreads statements across sessions. A Worker also must
never migrate: workerd has no long-lived connection, a deploy cannot order a Worker after its own
boot, and a failed migration would surface as a request failure.

**The deploy cannot see a SQL change.** Alchemy diffs resource props. A column added to the
description and a replaced database are invisible to that diff, so an unchanged deploy would look
identical to a changed one. The deploy needs a value that changes exactly when the
work does, and the Worker needs to depend on it, or it will serve requests against a schema that
does not exist yet.

**Observation is unavoidable, and the obvious use of it is a trap.** A live database can be behind
the description (a new column) or ahead of it (a manual fix, a rollback of code but not data). Once
the deploy can read the live catalog, the next step looks free: diff the two and generate whatever
`ALTER` / `DROP` closes the gap. That turns a deploy into a schema writer. The DDL is unreviewed,
the direction of a change is a guess, a dropped column destroys the event log that is the truth, and
two environments that diverged converge on whatever their own live state says instead of on one
committed description. [ADR 0003](./0003-the-deploy-provisions-the-vendor.md) already refuses that
class of destruction for vendor objects; a database is not a lesser case.

Two smaller facts belong in the context. Better Auth owns its own schema through
`@alchemy.run/better-auth`'s migrator, and paykit owns the `billing_*` tables through the schema
below; a deployment may put both families on one database or on two. And D1 has no interactive
transactions — one `batch` is the closest it offers — so a billing store and any auth plugin that
needs them belong on Postgres.

## Decision

**1. One port, with two obligations.** `@potion.run/paykit` gains `Paykit.Database`. A target
supplies one `DatabaseService`:

```ts
interface DatabaseService {
  dialect: "sqlite" | "postgres" | "mysql";
  schema?: string; // the Postgres schema, when the target has one
  identity: Input<Record<string, unknown>>; // non-secret identity of the target
  runtime: Effect<SqlExecutor, never, RuntimeContext | Scope.Scope>; // per execution
  migrate?: {
    // absent when the target cannot migrate
    connect: Effect<Effect<SqlExecutor, MigrationApplyError, Scope.Scope>, never, RuntimeContext>;
  };
}
```

`runtime` is evaluated once per execution and its client or pool is closed with the execution's
scope, which is the only pooling shape workerd allows. `migrate.connect` is two-stage for the same
reason Alchemy's better-auth port is: the outer effect runs at stack evaluation under the Action's
capture context and yields the resource outputs the engine records, and the inner effect runs in the
Action's body, acquires a dedicated connection on the Scope, and yields the executor. `identity` is
non-secret and is part of the Action's input; it never contains a connection string, because Action
input is persisted to state. `schema` is the Postgres schema (`billing` by default, and `public` is
never touched); SQLite has no schemas and ignores it.

The model, the stores and the policies resolve `DatabaseService` and never import a driver. A
deployment provides one layer and the model reads the executor from it.

**2. One layer per target, from its own export condition.** The layers are `Database/Sqlite`,
`Database/Postgres` and `Database/D1`, never entries on the barrel. The driver is a peer dependency,
so a Worker that imports the barrel must not pull `pg` or `bun:sqlite` into its bundle, and a Bun
test must not pull a D1 binding into it. A target that cannot migrate simply leaves `migrate` absent;
a deployment that migrates outside the port passes `migrate: false` and opts out.

**3. The schema is a description.** `BILLING_SCHEMA` is typed data — tables, columns and indexes —
and the renderer is the only thing that turns it into DDL, per dialect. No `.sql` file is committed:
the registry keys applied history by the hash of the *baseline* (`BILLING_SCHEMA_V1`) rendering, and
a test pins that hash, so the thing a database recorded can never move. A column type is written
once, a dialect difference (`INTEGER` versus `BIGINT` for epoch millis, `AUTOINCREMENT` versus
`BIGSERIAL` versus `AUTO_INCREMENT`, key columns versus `VARCHAR(191)`, identifier quoting) belongs
to the renderer, and a review reads a data change instead of SQL.

**4. The baseline is frozen; convergence is the delta.** A deploy applies the frozen baseline through
`@alchemy.run/sql/Migrations` — the registry owns the bookkeeping table, the content hashes and the
refusal of a rewritten applied file — and then *converges* the description against the
live database. Convergence observes the live catalog (`information_schema` on Postgres,
`pragma_table_info` on SQLite), computes what the description states and the database lacks, and adds
missing columns and indexes. It never drops, renames, retypes or narrows anything. Adding a `NOT NULL`
column without a default is a typed refusal naming the table and column, not a silent `ALTER` against
a table that may already hold rows. A new table is a file the renderer produces; a new column or
index on an existing table is a delta convergence applies. Each step is independently idempotent:
crash mid-deploy, re-run, converge.

**5. The deploy Action is fingerprinted.** `Paykit.Migrations` registers one Action per migrated
target whose input is `{ identity, schemaFingerprint, migrationFingerprint, dialect }`. A new shipped
file, a description change, or a different target database changes the input and re-runs the Action;
an unchanged deploy is a no-op. The Action runs only at apply — never at plan, never in the deployed
runtime — and its output is bound into the host environment, so the Worker depends on it and cannot
start against a half-migrated database. `migrate: false` opts out, which is how D1 keeps the
directory its resource already applies.

**6. Auth and billing own their own schema.** Better Auth migrates its tables through its own
migrator; paykit migrates `billing_*` through this one. Neither reads or writes the other's tables,
so one database with two disjoint table families and two databases are both supported, and a version
in either product never rewrites the other's history. The rule is ownership, not one database per
process.

## Consequences

- `Paykit.Database` and `DatabaseService`; the `Database/Sqlite`, `Database/Postgres` and
  `Database/D1` layers with their drivers as peers.
- `BILLING_SCHEMA` becomes the source; `BILLING_SCHEMA_V1` is the frozen baseline `migrationFiles()`
  renders; a test pins the rendered hash, and no `.sql` file is committed. The derived-file drift
  gate (`pnpm migrations:check`) is removed with the files.
- `BillingStack(id, { migrate })` is the one call: it registers the Action when a `Paykit.Database`
  layer is in context, and `migrate: false` opts out — the same shape as `BetterAuth({ migrate })`.
- The per-example migration Actions are gone. The Postgres example's `MigrateBilling` became the
  port's `migrate.connect`; D1 gained a migration connection over the HTTP API, so its resource no
  longer needs a `migrations` directory.
- `pnpm schema <dialect>` replaces the `node scripts/schema.ts … > …` incantation in the examples'
  READMEs.
- A deploy that changes nothing about the schema does no database work: the Action is not re-run and
  the Worker's dependency on its output is already satisfied.
- The migration input holds an identity, two fingerprints and a dialect. A connection string, a
  password or a full URL is never persisted in state.
- A change that is not additive — dropping a column, retyping one, renaming a table — is a new ADR
  and a reviewed migration, not something a deploy infers. The event log is the truth and is never
  destroyed to make a schema agree.
- MySQL is a third dialect, and it is not only a renderer case. Its `TEXT` columns cannot be a
  primary key or an index without a prefix length, so the description marks the columns a key or an
  index touches and renders those as `VARCHAR(191)`; MySQL 8 has no `CREATE INDEX IF NOT EXISTS`, so
  convergence asks `information_schema.statistics` first; and its upserts spell
  `ON DUPLICATE KEY UPDATE col = VALUES(col)`, so `Store/Upsert.ts` is the one place the three
  spellings live. The live case is gated on `MYSQL_URL`, because a rendering test cannot prove a
  server accepts the DDL.
- Drizzle is a connection, never the schema owner: `Database/Drizzle` unwraps the pool an application
  already holds and paykit's stores write their own SQL through it. Letting Drizzle generate the
  schema would make the user's ORM the source and this description a generator.
- The registry stays Alchemy's. Paykit adds a description, a renderer, a convergence and a
  fingerprint; it does not grow a second migration framework.

## Alternatives considered

- **Deploy-time diffing that generates arbitrary `ALTER` / `DROP` from a live schema.** Rejected. It
  makes the live database the source of truth, so two environments with the same commit converge on
  different schemas. It generates DDL no one reviewed, guesses the direction of a change, and can
  drop a column the event log still needs, which [ADR
  0003](./0003-the-deploy-provisions-the-vendor.md) refuses for every object a bill references. A
  plan would need a live connection, and a rollback would become a data migration. The rule that
  survived: **additive convergence only, from a frozen baseline plus a description.**
- **Hand-written migration files.** Rejected: two sources (the renderer and the file), a dialect
  copied twice, drift that only a human notices, and a schema that no longer states what the store
  needs. A *committed rendering* was a half-step: it kept a reviewable artifact, but it made every
  schema change a file edit and a drift gate, so the file went and the frozen baseline took its
  place.
- **A general-purpose migration framework or an ORM as the source.** Rejected: the description is two
  table classes and a fixed set of columns, the registry already owns bookkeeping and drift refusal,
  and a generated client is another runtime the model does not use. Drizzle's pool is welcome as a
  connection; its schema is not paykit's source.
- **Migrating from the Worker, at boot or on first request.** Rejected: workerd has no long-lived
  session, a deploy cannot order the Worker after its own boot, every concurrent cold start races the
  same migration, and a failed migration becomes an availability failure rather than a deploy
  failure.
- **Reusing the runtime connection for migrations.** Rejected: Hyperdrive's URL exists only inside
  the Worker, a pooled connection cannot hold `search_path`, and a migration that shares the request
  path shares its failure modes. The two obligations are separate for the same reason Alchemy's
  better-auth port separates them.
- **One migrator for auth and billing.** Rejected: it would make one product own the other's history,
  couple their versions, and turn an auth plugin's table change into a paykit deploy. Disjoint table
  families in one database, or two databases, keep the ownership rule intact.
- **Dropping and recreating the schema on a change.** Rejected for any target that has answered a
  request: it destroys the append-only event log, which is the only truth, and the read models are
  cheap to rebuild only because the log survives.
- **A hand-maintained schema version with no target identity.** Rejected: a replaced database would
  look up to date, and a rewritten file would be invisible. The fingerprint covers the target, the
  description and the files together.

## What would reopen this

- **A destructive change the product requires**, such as dropping a column or retyping money. It
  needs its own record, an explicit retention or archive rule and a reviewed migration; it must not
  arrive through convergence.
- **A fourth dialect.** Each one costs a keyed-column rule, an index-existence check and an upsert
  spelling, not a flag; `Store/Upsert.ts` and `Migrations/Schema.ts` are where that shows up.
- **A target that cannot be introspected** (an HTTP-only database with no catalog read). Convergence
  would need a different observation, or the target ships files only.
- **Drizzle or another ORM as the schema owner.** The description would become a generator for
  someone else's schema rather than the source, and convergence would have to defer to their
  migrator. Using a Drizzle *pool* is already supported and does not reopen this.
- **A schema per tenant.** `schema` becomes a decision at connect time and every fingerprint gains a
  tenant dimension.
- **A migration that must backfill data**, not only DDL. That is a job with a progress record, not a
  column add, and it belongs beside the deploy rather than inside it.

## See also

- [0003](./0003-the-deploy-provisions-the-vendor.md) — a deploy replaces, retains and never deletes
  what a bill references.
- [0047](./0047-a-plan-is-versioned-and-a-move-is-its-migration.md) — a deploy never
  rewrites state a customer already bought; here it never rewrites DDL a database already applied.
- [Database](../../website/docs/database.mdx) (the site page) and `packages/paykit/AGENTS.md` § Storage
  for the two table classes and the store guarantees.
- Alchemy's `@alchemy.run/sql/Migrations` registry and `@alchemy.run/better-auth`'s `DatabaseService`
  for the port and the Action shape this decision follows.
