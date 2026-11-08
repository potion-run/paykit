// Checks the publishable packages before a release, and on every commit that
// touches a manifest.
//
//   pnpm validate:publish-packages
//
// - Every `packages/*` package carries the npm metadata a release needs.
// - The packages share one version: they are released in lockstep.
// - An internal dependency is `workspace:*`, so a release never pins one
//   `@potion.run` package to a stale line of another.
// - The root does not publish.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  publishablePackages,
  readManifest,
  sharedVersion,
  type WorkspacePackage,
} from "./package-manifest.ts";

class InvalidPublishMetadata extends Data.TaggedError("InvalidPublishMetadata")<{
  readonly message: string;
  readonly dirs: ReadonlyArray<string>;
}> {}

/** The fields npm shows on the package page and the release reads. */
const required = ["name", "version", "description", "license", "repository", "files", "exports"];

/** The tarball carries the build output and the source it was built from. */
const publishedFiles = ["lib", "src"];

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies"] as const;

/** Everything wrong with one package's manifest, as lines a human can act on. */
const manifestProblems = ({ dir, raw }: WorkspacePackage): ReadonlyArray<string> => {
  const problems: Array<string> = [];

  for (const field of required) {
    if (raw[field] === undefined) problems.push(`${dir}: missing \`${field}\``);
  }

  // SAFETY: package.json is JSON; the manifest is validated field by field in this check.
  const publishConfig = raw.publishConfig as { access?: unknown } | undefined;

  if (publishConfig?.access !== "public") {
    problems.push(`${dir}: \`publishConfig.access\` must be "public"`);
  }

  const files = Array.isArray(raw.files) ? raw.files : [];

  for (const file of publishedFiles) {
    if (!files.includes(file)) problems.push(`${dir}: \`files\` must include "${file}"`);
  }

  for (const field of dependencyFields) {
    const dependencies = raw[field];

    if (typeof dependencies !== "object" || dependencies === null) continue;

    for (const [name, spec] of Object.entries(dependencies)) {
      // Internal dependencies follow the workspace, so the packages never drift.
      if (name.startsWith("@potion.run/") && spec !== "workspace:*") {
        problems.push(`${dir}: ${field}["${name}"] must be "workspace:*", found "${String(spec)}"`);
      }
    }
  }

  return problems;
};

const validate = Effect.fn("PublishPackages.validate")(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const problems: Array<string> = [];
  const invalid: Array<string> = [];

  const manifest = yield* readManifest(root, ".");

  if (manifest.manifest.private !== true) {
    problems.push("package.json: the root manifest must be private; the root does not publish");
    invalid.push(".");
  }

  const packages = yield* publishablePackages(root, "packages");

  for (const pkg of packages) {
    const found = manifestProblems(pkg);

    if (found.length > 0) {
      problems.push(...found);
      invalid.push(pkg.dir);
    }
  }

  // A version mismatch is one more problem to report, not a reason to stop
  // before the problems above are printed.
  const version = yield* sharedVersion(packages).pipe(
    Effect.catchTag("VersionMismatch", (mismatch) => {
      problems.push(mismatch.message);

      return Effect.succeed(undefined);
    }),
  );

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new InvalidPublishMetadata({
      message: `${problems.length} problem(s) in ${invalid.length === 0 ? "the manifests" : `${invalid.length} manifest(s)`}`,
      dirs: invalid,
    });
  }

  yield* Console.log(`Validated ${packages.length} packages at ${version}`);
});

validate().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
