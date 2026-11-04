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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = "packages";

const bump = (current: string, input: string): string => {
  if (/^\d+\.\d+\.\d+$/.test(input)) return input;
  const [major, minor, patch] = current.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`"${current}" is not a version`);
  }
  switch (input) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`"${input}" is not patch, minor, major or x.y.z`);
  }
};

const input = process.argv[2];
if (input === undefined) {
  console.error("usage: bump.ts patch|minor|major|x.y.z");
  process.exit(1);
}

const dirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PACKAGES, entry.name));

const manifests = dirs.map((dir) => join(dir, "package.json"));

// The version every package shares is the first published one's; a repo that
// has drifted is a release that would ship two versions, so refuse instead.
const versions = new Set(
  manifests.map((path) => JSON.parse(readFileSync(path, "utf8")).version as string),
);
if (versions.size !== 1) {
  console.error(`packages disagree about the version: ${[...versions].join(", ")}`);
  process.exit(1);
}

const current = [...versions][0]!;
const next = bump(current, input);

for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = next;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path}: ${current} -> ${next}`);
}

// Consumed by `release.yml` as `$GITHUB_OUTPUT`.
console.log(`version=${next}`);
