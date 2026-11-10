// Checks that the SQL committed under `examples/*/migrations` is the DDL
// `@potion.run/paykit` ships.
//
//   pnpm migrations:check
//
// `migrationFiles()` is the source of truth: the library renders it, a test
// applies it, and a deploy applies the committed files. Nothing else holds the
// two together, so a table added to the renderer and not regenerated here would
// reach a database as a migration the tests never ran. This gate compares each
// example's committed set — every `*.sql` in name order, joined the way
// `packages/paykit/scripts/schema.ts` writes a full set — against the shipped
// migrations for the dialect and schema that example deploys.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { migrationFiles } from "@potion.run/paykit";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** One example's committed migrations, and the scope they were rendered for. */
interface Target {
  /** The directory under `examples/`, e.g. `billing`. */
  readonly example: string;
  readonly dialect: "postgres" | "sqlite";
  /** The Postgres schema; undefined for SQLite, which has none. */
  readonly schema: string | undefined;
}

/** The examples a deploy applies DDL from. There are two. */
const TARGETS: ReadonlyArray<Target> = [
  { example: "billing", dialect: "sqlite", schema: undefined },
  { example: "postgres", dialect: "postgres", schema: "billing" },
];

/** One committed file: its name on disk, its migration id, and its SQL. */
interface CommittedMigration {
  readonly name: string;
  readonly id: string;
  readonly sql: string;
}

class MigrationsDrifted extends Data.TaggedError("MigrationsDrifted")<{
  readonly message: string;
  readonly problems: ReadonlyArray<string>;
}> {}

/** Codepoint order, so the set joins in the same order everywhere. */
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** A path relative to the repo root, for a message a reader can paste. */
const directoryOf = (target: Target): string => `examples/${target.example}/migrations`;

const fileOf = (target: Target, id: string): string => `${directoryOf(target)}/${id}.sql`;

/**
 * The command that rewrites one committed file from the shipped DDL. The
 * Postgres target uses the default schema, which `schema.ts` renders.
 */
const regenerate = (target: Target, id: string): string =>
  `node packages/paykit/scripts/schema.ts ${target.dialect} --file=${id} > ${fileOf(target, id)}`;

/** The bytes `schema.ts` writes for a whole set: each migration, then one newline. */
const renderSet = (sqls: ReadonlyArray<string>): string => `${sqls.join("\n")}\n`;

/** The first line two renders disagree on. */
interface Difference {
  /** The 1-based line number in the expected render. */
  readonly line: number;
  readonly expected: string;
  readonly actual: string;
}

/** Locate the first line two renders disagree on, marking a missing line as EOF. */
const firstDifference = (expected: string, actual: string): Difference => {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const lines = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < lines; index++) {
    const want = expectedLines.at(index);
    const have = actualLines.at(index);

    if (want === have) continue;

    return {
      line: index + 1,
      expected: want ?? "<end of file>",
      actual: have ?? "<end of file>",
    };
  }

  return { line: 1, expected, actual };
};

/** Every `*.sql` in the directory, in name order, read as one migration apiece. */
const readCommitted = Effect.fn("Migrations.readCommitted")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".sql"));
  names.sort(byName);

  return yield* Effect.forEach(names, (name) =>
    Effect.map(fs.readFileString(path.join(dir, name)), (text) => ({
      name,
      id: name.slice(0, -".sql".length),
      // A committed file is one migration plus the newline a text file ends
      // with. `schema.ts` adds that newline itself when it writes a full set,
      // so drop the file's own before joining; otherwise every file boundary
      // gains a blank line the shipped render does not have.
      sql: text.endsWith("\n") ? text.slice(0, -1) : text,
    })),
  );
});

/** Everything wrong with one example's committed set, as lines a human can act on. */
const problemsIn = (
  target: Target,
  shipped: ReadonlyArray<{ readonly id: string; readonly sql: string }>,
  committed: ReadonlyArray<CommittedMigration>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const shippedIds = shipped.map((file) => file.id);
  const committedIds = committed.map((file) => file.id);
  const shippedSet = new Set(shippedIds);
  const committedSet = new Set(committedIds);

  for (const file of shipped) {
    if (committedSet.has(file.id)) continue;

    problems.push(
      [
        `${fileOf(target, file.id)} is missing: paykit ships migration ${file.id}`,
        `  regenerate: ${regenerate(target, file.id)}`,
      ].join("\n"),
    );
  }

  for (const file of committed) {
    if (shippedSet.has(file.id)) continue;

    problems.push(
      [
        `${fileOf(target, file.id)} is committed but paykit ships no migration ${file.id}`,
        "  remove it, or append the migration it was rendered from to migrationFiles()",
      ].join("\n"),
    );
  }

  if (problems.length > 0) return problems;

  // The directory is read in name order, so a set that matches but whose ids
  // are not in shipped order means the shipped list itself is out of order.
  if (committedIds.join("\n") !== shippedIds.join("\n")) {
    problems.push(
      [
        `${directoryOf(target)}: files are not in shipped order`,
        `  committed: ${committedIds.join(", ")}`,
        `  shipped:   ${shippedIds.join(", ")}`,
      ].join("\n"),
    );

    return problems;
  }

  const expected = renderSet(shipped.map((file) => file.sql));
  const actual = renderSet(committed.map((file) => file.sql));

  if (expected === actual) return problems;

  // The ids line up, so name the first file whose bytes differ and the first
  // line inside it; a line number in the concatenation is not actionable.
  for (const [index, file] of shipped.entries()) {
    const committedFile = committed[index];

    if (committedFile === undefined || committedFile.sql === file.sql) continue;

    const difference = firstDifference(file.sql, committedFile.sql);

    problems.push(
      [
        `${fileOf(target, file.id)} differs from the shipped migration ${file.id}`,
        `  line ${difference.line} expected: ${difference.expected}`,
        `  line ${difference.line} actual:   ${difference.actual}`,
        `  regenerate: ${regenerate(target, file.id)}`,
      ].join("\n"),
    );

    break;
  }

  if (problems.length === 0) {
    // Same files in the same order, different bytes: only a file boundary can differ.
    const difference = firstDifference(expected, actual);

    problems.push(
      [
        `${directoryOf(target)} differs from the shipped set at line ${difference.line}`,
        `  expected: ${difference.expected}`,
        `  actual:   ${difference.actual}`,
      ].join("\n"),
    );
  }

  return problems;
};

const check = Effect.fn("Migrations.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const problems: Array<string> = [];

  for (const target of TARGETS) {
    const dir = path.join(root, directoryOf(target));

    if (!(yield* fs.exists(dir))) {
      problems.push(`${directoryOf(target)}: the migrations directory is missing`);
      continue;
    }

    const committed = yield* readCommitted(dir);

    const shipped = migrationFiles(
      target.schema === undefined
        ? { dialect: target.dialect }
        : { dialect: target.dialect, schema: target.schema },
    );

    const found = problemsIn(target, shipped, committed);

    if (found.length > 0) {
      problems.push(...found);
      continue;
    }

    const count = shipped.length;

    yield* Console.log(
      `ok  examples/${target.example} (${target.dialect}, ${count} file${count === 1 ? "" : "s"})`,
    );
  }

  if (problems.length > 0) {
    yield* Console.error(problems.join("\n\n"));

    return yield* new MigrationsDrifted({
      message: `${problems.length} problem(s) in the committed migrations`,
      problems,
    });
  }
});

check().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
