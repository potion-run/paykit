/**
 * Render paykit's schema as SQL, so a hosted database can apply it as a
 * migration file. The source of truth is `migrationFiles`, so the file a
 * deploy runs and the DDL a test runs cannot drift.
 *
 * Usage:
 *   node packages/paykit/scripts/schema.ts [sqlite|postgres] > migrations/0001_init.sql
 *   node packages/paykit/scripts/schema.ts [sqlite|postgres] --file=0001_init > migrations/0001_init.sql
 */
import { migrationFiles } from "../src/Migrations/index.ts";

const args = process.argv.slice(2);
const dialect = args.includes("postgres") ? "postgres" : "sqlite";
const only = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
const files = migrationFiles({ dialect });
const selected = only === undefined ? files : files.filter((file) => file.id === only);
if (selected.length === 0) {
  console.error(`no migration named "${only}" (have: ${files.map((file) => file.id).join(", ")})`);
  process.exit(1);
}
process.stdout.write(`${selected.map((file) => file.sql).join("\n")}\n`);
