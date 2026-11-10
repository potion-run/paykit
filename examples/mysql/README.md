# MySQL example

The billing model on MySQL, with the schema applied by a deploy.

```sh
MYSQL_URL=mysql://user:pass@host:3306/paykit_test pnpm --filter @potion.run/example-mysql deploy
MYSQL_URL=mysql://user:pass@host:3306/paykit_test pnpm --filter @potion.run/example-mysql test
```

The stack declares the catalog and registers paykit's migration Action. The
Action is keyed by the target's identity, the shipped DDL's fingerprint, the
shipped files' fingerprint and the dialect, so a first deploy applies
`0001_init`, a later deploy with a changed `BILLING_SCHEMA` converges, and an
unchanged deploy does no database work.

The model is hosted by whatever process runs it:

```ts
import * as SQL from "@alchemy.run/sql/MySQL";
import { mysqlExecutor } from "@potion.run/paykit";

const client = yield* SQL.MySQL({ url: connectionString });
const { world } = billingOnMysql(mysqlExecutor(client));
```

`SQL.MySQL` is Alchemy's `@effect/sql-mysql2` client: one pool per execution,
closed when the event settles. MySQL binds `?` natively, so paykit's adapter
does not rewrite placeholders.

## What is MySQL-specific

| Concern | What paykit does |
| --- | --- |
| Identifier quoting | Backticks, through Alchemy's `quoteIdentifier` |
| Key columns | `VARCHAR(191)`, because MySQL rejects `TEXT` in a primary key or index without a prefix length |
| Surrogate keys | `BIGINT AUTO_INCREMENT PRIMARY KEY` |
| Booleans | `TINYINT(1)` (paykit's read model stores 0/1 as `INTEGER`) |
| Upserts | `ON DUPLICATE KEY UPDATE col = VALUES(col)` instead of `ON CONFLICT ... excluded` |
| Index creation | Plain `CREATE INDEX`; convergence checks `information_schema.statistics` first, because MySQL 8 has no `IF NOT EXISTS` |
| Schema | None: the namespace is the connection's database, so `DatabaseService.schema` is undefined |

## The live case

`test/example.test.ts` is gated on `MYSQL_URL`, the way every vendor case in
this repo is. Without it the case is skipped so CI stays green; with it the case
drops the `billing_*` tables, applies the shipped files, runs the model and
checks the event log. Run it in `live.yml`, not in a pull request from a fork.

A Worker reaches MySQL through a Hyperdrive MySQL origin; point `mysqlExecutor`
at the client `SQL.MySQL` builds from that connection string. Do not open a
socket at module scope in a Worker.
