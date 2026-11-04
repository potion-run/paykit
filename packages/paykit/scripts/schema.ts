/**
 * Render paykit's schema as SQL, so a hosted database can apply it as a
 * migration file. The source of truth is `migrationFiles`, so the file a
 * deploy runs and the DDL a test runs cannot drift.
 *
 * Usage: `bun run packages/paykit/scripts/schema.ts [sqlite|postgres] > migrations/0001_init.sql`
 */
import { migrationFiles } from "../src/Migrations/index.ts";

const dialect = process.argv[2] === "postgres" ? "postgres" : "sqlite";
process.stdout.write(
  `${migrationFiles({ dialect })
    .map((file) => file.sql)
    .join("\n")}\n`,
);
