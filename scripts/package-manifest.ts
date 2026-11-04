// `package.json` reading shared by the manifest gates.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The `package.json` fields a gate needs before it can check anything else. */
export const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
});
export type PackageJson = typeof PackageJson.Type;

/** A whole `package.json`, so a gate can also read `exports`, `files` and `publishConfig`. */
const RawPackageJson = Schema.Record(Schema.String, Schema.Unknown);

/** A `package.json` that is not JSON, or has no `name` or `version`. */
export class UnreadableManifest extends Data.TaggedError("UnreadableManifest")<{
  readonly message: string;
  readonly file: string;
  readonly cause: unknown;
}> {}

export interface WorkspacePackage {
  /** Directory relative to the workspace root, e.g. `packages/paykit`. */
  readonly dir: string;
  readonly manifest: PackageJson;
  /** Every field of the manifest, for the checks the schema does not name. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Read and decode `<root>/<dir>/package.json`. */
export const readManifest = Effect.fn("PackageManifest.read")(function* (
  root: string,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, dir, "package.json");
  const text = yield* fs.readFileString(file);
  const raw = yield* Schema.decodeEffect(Schema.fromJsonString(RawPackageJson))(text).pipe(
    Effect.mapError(
      (cause) =>
        new UnreadableManifest({ message: `${dir}: package.json is not valid JSON`, file, cause }),
    ),
  );
  const manifest = yield* Schema.decodeUnknownEffect(PackageJson)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new UnreadableManifest({
          message: `${dir}: package.json needs a string name and version`,
          file,
          cause,
        }),
    ),
  );
  return { dir, manifest, raw } satisfies WorkspacePackage;
});

/** Every workspace package directly under `directory`, private ones included. */
export const workspacePackages = Effect.fn("PackageManifest.workspace")(function* (
  root: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = (yield* fs.readDirectory(path.join(root, directory))).sort();
  const packages = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const full = path.join(root, directory, entry);
      // Skip stray files such as `.DS_Store`, and directories without a manifest.
      if ((yield* fs.stat(full)).type !== "Directory") return undefined;
      if (!(yield* fs.exists(path.join(full, "package.json")))) return undefined;
      return yield* readManifest(root, path.join(directory, entry));
    }),
  );
  return packages.filter((pkg): pkg is WorkspacePackage => pkg !== undefined);
});

/** Every package under `directory` that publishes; the private ones are skipped. */
export const publishablePackages = Effect.fn("PackageManifest.publishable")(function* (
  root: string,
  directory: string,
) {
  const packages = yield* workspacePackages(root, directory);
  return packages.filter(({ manifest }) => manifest.private !== true);
});

/** Every file under `directory`, as paths relative to it, sorted. */
export const filesUnder = Effect.fn("PackageManifest.files")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const pending: Array<string> = [directory];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const entry of yield* fs.readDirectory(current)) {
      const full = path.join(current, entry);
      if ((yield* fs.stat(full)).type === "Directory") pending.push(full);
      else files.push(path.relative(directory, full));
    }
  }
  return files.sort();
});

export class VersionMismatch extends Data.TaggedError("VersionMismatch")<{
  readonly message: string;
  readonly specs: ReadonlyArray<string>;
}> {}

/** The one version every package carries; they are released in lockstep. */
export const sharedVersion = Effect.fn("PackageManifest.sharedVersion")(function* (
  packages: ReadonlyArray<WorkspacePackage>,
) {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    const specs = packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`);
    // Name the packages on each version, except where that is most of them.
    const groups = [...versions].map((version) => {
      const names = packages
        .filter(({ manifest }) => manifest.version === version)
        .map(({ manifest }) => manifest.name);
      return `${version}: ${names.length > 5 ? `${names.length} packages` : names.join(", ")}`;
    });
    return yield* new VersionMismatch({
      message: `Packages must share one version; found ${groups.join("; ")}`,
      specs,
    });
  }
  return [...versions][0];
});
