// Model-checks every model in `spec/`.
//
//   pnpm spec
//
// A model is `<Name>.tla` beside `<Name>.cfg`: the module is the design, the
// config is the scope the checker searches. `tla-ts` is TLC without the JVM, so
// this gate needs no toolchain beyond `pnpm install`.
//
// A run must reach `success`. A violation prints the counterexample as a
// numbered trace — that trace is the reproducible interleaving, and the input
// to a test under `packages/paykit/test/`. A model whose invariants have never
// been made to fail is a model nobody has tested: every config here has a
// commented twin that flips its constant and shows what the invariant catches.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { check, formatValue, type CheckResult, type TraceStep } from "tla-ts";

/** A model that did not reach `success`, with the trace that says why. */
class SpecViolation extends Data.TaggedError("SpecViolation")<{
  readonly module: string;
  readonly status: string;
  readonly detail: string;
}> {}

/**
 * One state of a counterexample. Only the variables that moved are shown: the
 * initial state prints in full, and every step after it prints its delta, so a
 * thirty-step trace stays readable.
 */
const renderStep = (step: TraceStep, index: number, previous: TraceStep | undefined): string => {
  const changed = Object.keys(step.state)
    .sort()
    .filter(
      (name) =>
        previous === undefined ||
        formatValue(previous.state[name]!) !== formatValue(step.state[name]!),
    );
  const variables = changed.map((name) => `      ${name} = ${formatValue(step.state[name]!)}`);
  const action = step.action ?? "init";
  if (variables.length === 0) return `    ${index}. ${action}`;
  return [`    ${index}. ${action}`, ...variables].join("\n");
};

/** The part of a failed run a reader needs: what broke, and the path to it. */
const detailOf = (result: CheckResult): string => {
  if (result.failure !== undefined) {
    return `evaluation failed: ${result.failure.message}`;
  }
  const violation = result.violation;
  if (violation === undefined) return `status ${result.status} with no violation`;
  const header = `${violation.name} is false${
    violation.message === undefined ? "" : `: ${violation.message}`
  }`;
  const steps = violation.trace.map((step, index) =>
    renderStep(step, index, index === 0 ? undefined : violation.trace[index - 1]),
  );
  return [header, ...steps].join("\n");
};

const specDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(path.resolve(import.meta.dirname, ".."), "spec");
});

/** Every `<Name>.cfg` in `spec/`, paired with its module. */
const models = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* specDirectory;
  const entries = yield* fs.readDirectory(directory);
  const configs = entries.filter((entry) => entry.endsWith(".cfg")).sort();
  const found: Array<{ name: string; module: string; config: string }> = [];
  for (const config of configs) {
    const name = config.slice(0, -".cfg".length);
    const module = path.join(directory, `${name}.tla`);
    if (!(yield* fs.exists(module))) continue;
    found.push({
      name,
      module: yield* fs.readFileString(module),
      config: yield* fs.readFileString(path.join(directory, config)),
    });
  }
  return found;
});

const checkModel = Effect.fn("Spec.checkModel")(function* (model: {
  readonly name: string;
  readonly module: string;
  readonly config: string;
}) {
  const result = yield* Effect.tryPromise({
    try: () => check({ source: model.module, config: model.config, workers: 1 }),
    catch: (cause) =>
      new SpecViolation({ module: model.name, status: "error", detail: String(cause) }),
  });
  if (result.status !== "success") {
    return yield* new SpecViolation({
      module: model.name,
      status: result.status,
      detail: detailOf(result),
    });
  }
  yield* Console.log(
    `${model.name}: ${result.distinctStates} distinct states, ${result.depth} deep.`,
  );
});

const checkAll = Effect.fn("Spec.checkAll")(function* () {
  const found = yield* models;
  if (found.length === 0) {
    yield* Console.error("  spec/: no <Name>.cfg with a matching <Name>.tla");
    return yield* new SpecViolation({
      module: "spec",
      status: "error",
      detail: "nothing to check",
    });
  }
  yield* Effect.forEach(found, checkModel, { discard: true });
  yield* Console.log(`Checked ${found.length} model(s): every invariant holds in its scope.`);
});

checkAll().pipe(
  Effect.catchTag("SpecViolation", (violation) =>
    Console.error(`\n${violation.module}: ${violation.status}\n${violation.detail}`).pipe(
      Effect.andThen(Effect.fail(violation)),
    ),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
