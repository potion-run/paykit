/**
 * Bump every published package onto one version line.
 *
 * This repo ships every `@potion.run/*` package at the same version, so a
 * release edits each `packages/*​/package.json` and nothing else: internal
 * dependencies are `workspace:*`, so no range is rewritten. No git operation —
 * `release.yml` tags what shipped, and a version that only exists in a commit
 * nobody tagged is not a release.
 *
 * Usage: `node scripts/release/bump.ts patch|minor|major|x.y.z`
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PACKAGES = "packages";

/** A `package.json` is JSON; the fields a bump touches are checked explicitly. */
const RawManifest = Schema.Record(Schema.String, Schema.Unknown);

class BadVersion extends Data.TaggedError("BadVersion")<{
  readonly message: string;
}> {}

class UnreadableManifest extends Data.TaggedError("UnreadableManifest")<{
  readonly message: string;
  readonly file: string;
  readonly cause: unknown;
}> {}

/** The next version, or a refusal naming what the input should have been. */
const nextVersion = (current: string, input: string): Effect.Effect<string, BadVersion> => {
  if (/^\d+\.\d+\.\d+$/.test(input)) return Effect.succeed(input);
  const [major, minor, patch] = current.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    return Effect.fail(new BadVersion({ message: `"${current}" is not a version` }));
  }
  switch (input) {
    case "major":
      return Effect.succeed(`${major + 1}.0.0`);
    case "minor":
      return Effect.succeed(`${major}.${minor + 1}.0`);
    case "patch":
      return Effect.succeed(`${major}.${minor}.${patch + 1}`);
    default:
      return Effect.fail(
        new BadVersion({ message: `"${input}" is not patch, minor, major or x.y.z` }),
      );
  }
};

const readManifest = Effect.fn("Release.readManifest")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  const raw = yield* Schema.decodeEffect(Schema.fromJsonString(RawManifest))(text).pipe(
    Effect.mapError(
      (cause) =>
        new UnreadableManifest({
          message: `${file}: package.json is not valid JSON`,
          file,
          cause,
        }),
    ),
  );
  const version = raw.version;
  if (typeof version !== "string") {
    return yield* new UnreadableManifest({
      message: `${file}: package.json has no string version`,
      file,
      cause: version,
    });
  }
  return { raw, version };
});

const bumpAll = Effect.fn("Release.bump")(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");
  const packages = path.join(root, PACKAGES);
  const files = (yield* fs.readDirectory(packages))
    .map((entry) => path.join(packages, entry, "package.json"))
    .sort();

  const manifests = yield* Effect.forEach(files, (file) =>
    Effect.map(readManifest(file), (manifest) => ({ file, ...manifest })),
  );
  const versions = new Set(manifests.map((manifest) => manifest.version));
  if (versions.size !== 1) {
    return yield* new BadVersion({
      message: `packages disagree about the version: ${[...versions].join(", ")}`,
    });
  }
  const current = [...versions][0]!;
  const next = yield* nextVersion(current, input);

  yield* Effect.forEach(
    manifests,
    (manifest) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          manifest.file,
          `${JSON.stringify({ ...manifest.raw, version: next }, null, 2)}\n`,
        );
        yield* Console.log(`${path.relative(root, manifest.file)}: ${current} -> ${next}`);
      }),
    { discard: true },
  );

  // Consumed by `release.yml` as `$GITHUB_OUTPUT`.
  yield* Console.log(`version=${next}`);
});

const input = process.argv[2];
if (input === undefined) {
  console.error("usage: bump.ts patch|minor|major|x.y.z");
  process.exit(1);
}

bumpAll(input).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
