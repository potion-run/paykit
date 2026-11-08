import { spawnSync } from "node:child_process";

const native = ["darwin-arm64", "linux-x64", "linux-arm64"];
const compiler = native.includes(`${process.platform}-${process.arch}`) ? "tsrs" : "tsc";

/**
 * Compile one package with `tsc -b`. Uses the native `tsrs` port wherever it
 * ships a binary, and the reference `tsc` everywhere else.
 */
export function build(packageDirectory: string): void {
  const result = spawnSync(compiler, ["-b", "--force"], {
    cwd: packageDirectory,
    stdio: "inherit",
  });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}
