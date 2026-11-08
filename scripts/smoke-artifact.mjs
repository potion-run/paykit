import { resolve } from "node:path";
/**
 * Load a built package entry in plain Node and assert it exposes what it
 * claims. This is the check that would have caught a `bun:` import reaching the
 * root export: the artifact built fine and could not be loaded at all.
 *
 * Usage: `node scripts/smoke-artifact.mjs packages/paykit/lib/index.js Paykit`
 */
import { pathToFileURL } from "node:url";

const [entry, ...expected] = process.argv.slice(2);

if (entry === undefined) {
  console.error("usage: smoke-artifact.mjs <lib/index.js> [exportName…]");
  process.exit(1);
}

const path = resolve(entry);
const module = await import(pathToFileURL(path).href);
const names = Object.keys(module);

if (names.length === 0) {
  console.error(`${entry} exports nothing`);
  process.exit(1);
}

const missing = expected.filter((name) => !(name in module));

if (missing.length > 0) {
  console.error(`${entry} is missing: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${entry}: ${names.length} exports, all named ones present`);
