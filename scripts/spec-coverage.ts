// Holds the paykit model's coverage table against the commands it claims to
// cover.
//
//   pnpm spec:coverage
//
// `specs/paykit/paykit.qnt` models a protocol, not a file, so there is no one
// action per command and never will be: two commands can be one action
// (`ScheduleCancellation` and `Expire` both end the standing) and a command can
// be deliberately out of scope for a slice. The table below is that decision
// written down, and this gate fails when the code and the table disagree in
// either direction:
//
//   - a new `*.command.ts` with no row, so a command cannot land unsorted;
//   - a row naming an action the model does not define, so a rename is caught;
//   - an `action` in the model that neither a row nor `MACHINE_ACTIONS` names,
//     so an action cannot be silently dropped.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Where the model and the commands it grounds live. */
const SPEC = "specs/paykit/paykit.qnt";
const COMMANDS = "packages/paykit/src/Subscription";

/**
 * The command behind each modelled action, and why everything else is out. A
 * row is a claim about this slice; moving a command in is a change to
 * `paykit.qnt` first.
 */
const SPEC_COVERAGE = {
  // Modelled. The value is the action in `paykit.qnt`.
  ClosePeriod: "closePeriod",
  ConsumeCredits: "consumeCredits",
  EnterGrace: "enterGrace",
  Expire: "cancelStanding",
  Hold: "hold",
  HoldElapsed: "expireHold",
  PeriodEnded: "closePeriod",
  Recover: "recover",
  ReleaseHold: "releaseHold",
  ScheduleCancellation: "cancelStanding",
  SettleHold: "settleHold",
  Subscribe: "subscribe",
  TrackUsage: "trackUsage",

  // Out of this slice, with the reason. Every one of these moves a counter the
  // model does not have yet, or needs a vendor the model must not know about.
  AttachProviderRef: null, // provider ids, never read by `decide`
  ChangeTier: null, // tier state, proration and the two ceilings — next slice
  DunningRetry: null, // the dunning ladder needs a payment sitting
  ExtendTrial: null, // the model has no trial
  GraceElapsed: null, // the model's grace window has no deadline
  GrantCredits: null, // a second grant path; the model grants once, at activation
  PurchaseCredits: null, // a one-off pack, which needs the catalog to price
  QuantityProration: null, // quantity proration — next slice
  RecordPayment: null, // the payment plane, not the entitlement plane
  RecordPaymentFailure: null, // the payment plane
  RecordProrationInvoice: null, // the proration money plane
  RecordTopUpFailure: null, // auto top-up
  Refund: null, // the money plane and the refund ceiling
  ResetAllowance: null, // a window the period does not own: a second clock, next slice
  Resume: null, // a terminal standing is replaced, not moved (ADR 0020)
  RetryTopUp: null, // auto top-up
  ReverseRefund: null, // the money plane
  ScheduleTierChange: null, // tier state — next slice
  SetQuantity: null, // quantities (seats) — next slice
  StartTrial: null, // the model has no trial
  TopUpCooldownElapsed: null, // auto top-up
  WithdrawTierChange: null, // tier state — next slice
} as const satisfies Readonly<Record<string, string | null>>;

/**
 * Actions that are part of the machine rather than of the protocol: `init` and
 * `step` are the entry points, and `tick` is the platform clock the policy
 * scheduler runs on, not a command.
 */
const MACHINE_ACTIONS: ReadonlyArray<string> = ["init", "step", "tick"];

class SpecCoverageViolated extends Data.TaggedError("SpecCoverageViolated")<{
  readonly problems: ReadonlyArray<string>;
}> {}

const actionsIn = (text: string): ReadonlySet<string> =>
  new Set([...text.matchAll(/^ {2}action (\w+)/gm)].map((match) => match[1]));

const commandNamesIn = (files: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) =>
      file.endsWith(".command.ts") ? [file.slice(0, -".command.ts".length)] : [],
    ),
  );

const coverage = Effect.fn("SpecCoverage.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = path.resolve(import.meta.dirname, "..");
  const spec = yield* fs.readFileString(path.join(root, SPEC));
  const actions = actionsIn(spec);
  const commands = commandNamesIn(yield* fs.readDirectory(path.join(root, COMMANDS)));
  const modelled = new Set<string>(Object.values(SPEC_COVERAGE).filter((row) => row !== null));

  const problems: Array<string> = [];

  for (const command of [...commands].sort()) {
    if (!(command in SPEC_COVERAGE)) {
      problems.push(`${command}.command.ts: no row in SPEC_COVERAGE — model it or say why not`);
    }
  }

  for (const command of Object.keys(SPEC_COVERAGE).sort()) {
    if (!commands.has(command)) {
      problems.push(`SPEC_COVERAGE: "${command}" has no ${command}.command.ts`);
    }
  }

  for (const action of modelled) {
    if (!actions.has(action)) {
      problems.push(`SPEC_COVERAGE names "${action}", which ${SPEC} does not define`);
    }
  }

  for (const action of [...actions].sort()) {
    if (modelled.has(action) || MACHINE_ACTIONS.includes(action)) continue;
    problems.push(`${SPEC}: action "${action}" has no row in SPEC_COVERAGE`);
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new SpecCoverageViolated({ problems });
  }

  yield* Console.log(
    `Checked ${commands.size} commands against ${actions.size} actions: ` +
      `${modelled.size} modelled, ${commands.size - modelled.size} out of this slice with a reason.`,
  );
});

coverage().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
