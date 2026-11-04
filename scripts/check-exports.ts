// Checks each package's export map against its source tree.
//
//   pnpm exports:check
//
// A package declares two maps. `exports` is what the workspace resolves and what
// a Bun or Worker consumer gets: the source. `publishConfig.exports` is what npm
// serves: the built `lib/`, with the source kept for `bun`/`worker`. This gate
// holds the two against each other and against `src/`, so a moved module or a
// renamed entry fails here rather than at import time in a consumer.
//
// A package may also not reach into another package's `src/`: the export map is
// the contract, and a `src/` path compiles today and breaks the moment a file
// moves.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { filesUnder, workspacePackages, type WorkspacePackage } from "./package-manifest.ts";

class InvalidExports extends Data.TaggedError("InvalidExports")<{
  readonly message: string;
  readonly dirs: ReadonlyArray<string>;
}> {}

/** Every condition `publishConfig.exports` must carry for a source target. */
const requiredConditions = ["types", "bun", "default"] as const;

/** The published conditions a development target derives; `undefined` when it is not source. */
const publishedConditions = (target: unknown): Record<string, string> | undefined => {
  if (typeof target !== "string") return undefined;
  if (!target.startsWith("./src/") || !target.endsWith(".ts")) return undefined;
  const lib = `./lib/${target.slice("./src/".length, -".ts".length)}`;
  return { types: `${lib}.d.ts`, bun: target, default: `${lib}.js` };
};

/** Whether some `exports` entry resolves `src/<rest>`, the file being `src/<rest>.ts`. */
const reachable = (exportsMap: Readonly<Record<string, unknown>>, file: string): boolean => {
  const subpath = `./${file.slice("src/".length, -".ts".length)}`;
  return Object.entries(exportsMap).some(([key, target]) => {
    if (typeof target !== "string") return false;
    const star = key.indexOf("*");
    if (star === -1) return target === `./${file}`;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return false;
    const rest = subpath.slice(prefix.length, subpath.length - suffix.length);
    return target.replace("*", rest) === `./${file}`;
  });
};

/** Everything wrong with one package's export maps, as lines a human can act on. */
const exportProblems = (
  { dir, raw }: WorkspacePackage,
  sourceFiles: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const dev = raw.exports;
  const publishConfig = raw.publishConfig as { exports?: unknown } | undefined;
  const published = publishConfig?.exports;
  if (typeof dev !== "object" || dev === null) return [`${dir}: no \`exports\` map`];
  if (typeof published !== "object" || published === null) {
    return [`${dir}: no \`publishConfig.exports\` map`];
  }
  const problems: Array<string> = [];
  const devMap = dev as Record<string, unknown>;
  const publishedMap = published as Record<string, unknown>;

  for (const key of Object.keys(devMap)) {
    if (!(key in publishedMap)) problems.push(`${dir}: \`publishConfig.exports\` has no "${key}"`);
  }
  for (const key of Object.keys(publishedMap)) {
    if (!(key in devMap)) {
      problems.push(
        `${dir}: \`publishConfig.exports\` publishes "${key}", which \`exports\` lacks`,
      );
    }
  }

  for (const [key, target] of Object.entries(devMap)) {
    const expected = publishedConditions(target);
    const actual = publishedMap[key];
    // A pass-through entry (`"./package.json"`) is published unchanged.
    if (expected === undefined) {
      if (typeof target === "string" && actual !== target) {
        problems.push(`${dir}: "${key}" publishes ${String(actual)}, expected ${target}`);
      }
      continue;
    }
    if (typeof actual !== "object" || actual === null) {
      problems.push(`${dir}: "${key}" is published as ${String(actual)}, expected its conditions`);
      continue;
    }
    const conditions = actual as Record<string, unknown>;
    for (const condition of requiredConditions) {
      if (conditions[condition] !== expected[condition]) {
        problems.push(
          `${dir}: "${key}".${condition} is ${String(conditions[condition])}, expected ${expected[condition]}`,
        );
      }
    }
    for (const [condition, value] of Object.entries(conditions)) {
      if (condition in expected) continue;
      // A condition this package adds (`worker`) may repeat a derived target,
      // but it may not point somewhere the dev map does not publish.
      if (!Object.values(expected).includes(value as string)) {
        problems.push(`${dir}: "${key}".${condition} is ${String(value)}, none of its targets`);
      }
    }
  }

  for (const file of sourceFiles) {
    if (!reachable(devMap, file)) {
      problems.push(`${dir}/${file} is not reachable from \`exports\``);
    }
  }
  return problems;
};

/** `@potion.run/<package>/src` — the import that bypasses the export map. */
const internalImport = /@potion\.run\/[a-z0-9-]+\/src\b/;

const check = Effect.fn("Exports.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const problems: Array<string> = [];
  const invalid = new Set<string>();

  const packages = yield* workspacePackages(root, "packages");
  const publishable = packages.filter(({ manifest }) => manifest.private !== true);

  for (const pkg of publishable) {
    const files = yield* filesUnder(path.join(root, pkg.dir));
    const sourceFiles = files.filter((file) => file.startsWith("src/") && file.endsWith(".ts"));
    const found = exportProblems(pkg, sourceFiles);
    if (found.length > 0) {
      problems.push(...found);
      invalid.add(pkg.dir);
    }
  }

  const examples = yield* workspacePackages(root, "examples");
  for (const { dir } of [...packages, ...examples]) {
    const files = yield* filesUnder(path.join(root, dir));
    for (const file of files) {
      // Build output and dependencies are not source.
      if (file.startsWith("lib/") || file.startsWith("node_modules/")) continue;
      if (!file.endsWith(".ts")) continue;
      const text = yield* fs.readFileString(path.join(root, dir, file));
      const match = internalImport.exec(text);
      if (match === null) continue;
      problems.push(`${dir}/${file} imports ${match[0]}: import through the export map`);
      invalid.add(dir);
    }
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));
    return yield* new InvalidExports({
      message: `${problems.length} export problem(s) in ${invalid.size} package(s)`,
      dirs: [...invalid].sort(),
    });
  }
  yield* Console.log(
    `Checked ${publishable.length} packages: every export resolves and every source file is reachable.`,
  );
});

check().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
