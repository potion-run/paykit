/**
 * Render paykit's schema as SQL, so an operator can read or apply it by hand.
 * The source of truth is `migrationFiles`, which is also what the deploy
 * applies — printing it is a convenience, not a build step.
 *
 * Usage:
 *   node packages/paykit/scripts/schema.ts [sqlite|postgres|mysql]
 *   node packages/paykit/scripts/schema.ts [sqlite|postgres|mysql] --file=0001_init
 */
import { migrationFiles } from "../src/Migrations/index.ts";

const args = process.argv.slice(2);

const dialect = args.includes("postgres")
  ? "postgres"
  : args.includes("mysql")
    ? "mysql"
    : "sqlite";

const only = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
const files = migrationFiles({ dialect });

const selected = only === undefined ? files : files.filter((file) => file.id === only);

if (selected.length === 0) {
  console.error(`no migration named "${only}" (have: ${files.map((file) => file.id).join(", ")})`);
  process.exit(1);
}

process.stdout.write(`${selected.map((file) => file.sql).join("\n")}\n`);
