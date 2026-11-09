// Holds the paykit models' coverage tables against the commands they claim to
// cover.
//
//   pnpm spec:coverage
//
// `specs/paykit` is one model per protocol, not one per file: `paykit.qnt` is
// the spend path, `standing.qnt` the phase machine, `windows.qnt` the clocks the
// period does not own, `balances.qnt` the sources behind one count, `entities.qnt`
// the scopes under one customer, `schedules.qnt` the plan set and its phase
// schedule, and `money.qnt` the money facts. A command can be modelled in more
// than one protocol (a purchase is a phase reset and a pool grant), and a
// command can be deliberately out of every slice. The table below is that
// decision written down; this gate fails when the code and the table disagree
// in either direction:
//
//   - a new `*.command.ts` with no row, so a command cannot land unsorted;
//   - a row naming a spec or action the model does not define, so a rename is
//     caught;
//   - an action in a model that neither a row nor `MACHINE_ACTIONS` names, so an
//     action cannot be silently dropped.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The commands whose moves the models ground. */
const COMMANDS = "packages/paykit/src/Subscription";

const SPEC_FILES = {
  paykit: "specs/paykit/paykit.qnt",
  standing: "specs/paykit/standing.qnt",
  windows: "specs/paykit/windows.qnt",
  plans: "specs/paykit/plans.qnt",
  balances: "specs/paykit/balances.qnt",
  controls: "specs/paykit/controls.qnt",
  schedules: "specs/paykit/schedules.qnt",
  entities: "specs/paykit/entities.qnt",
  money: "specs/paykit/money.qnt",
} as const;

type SpecName = keyof typeof SPEC_FILES;

const isSpecName = (value: string): value is SpecName => Object.hasOwn(SPEC_FILES, value);

/** The actions one command is modelled by, per protocol. */
type Coverage = Partial<Record<SpecName, ReadonlyArray<string>>>;

/**
 * The command behind each modelled action, and why everything else is out. A
 * row is a claim about the slices; moving a command in is a change to a model
 * first.
 */
const SPEC_COVERAGE = {
  // ── the spend path ─────────────────────────────────────────────────────────
  Hold: { paykit: ["hold"], balances: ["spend"], controls: ["refuse"] },
  GrantBalance: { balances: ["createGrant"], entities: ["grant"] },
  ExpireGrant: { balances: ["expireGrant"] },
  HoldElapsed: { paykit: ["expireHold"] },
  ReleaseHold: { paykit: ["releaseHold"] },
  SettleHold: { paykit: ["settleHold"] },
  TrackUsage: {
    paykit: ["trackUsage"],
    windows: ["track"],
    balances: ["spend"],
    controls: ["track", "fireAlert", "refuse"],
    entities: ["spend"],
  },
  ConsumeCredits: {
    paykit: ["consumeCredits"],
    standing: ["spendCredits"],
    windows: ["spendCredits"],
  },

  // ── the phase machine ──────────────────────────────────────────────────────
  StartTrial: { standing: ["startTrial"] },
  Subscribe: {
    paykit: ["subscribe"],
    standing: ["subscribe"],
    plans: ["attach"],
    schedules: ["attach", "addAddOn"],
    entities: ["attachPlan"],
  },
  ExtendTrial: { standing: ["extendTrial"] },
  EnterGrace: { paykit: ["enterGrace"], standing: ["enterGrace"] },
  RecordPayment: { standing: ["recordPayment"], money: ["charge"] },
  RecordPaymentFailure: { standing: ["failPayment"] },
  Recover: { paykit: ["recover"], standing: ["recover"] },
  GraceElapsed: { standing: ["graceElapsed"], windows: ["endStanding"] },
  Expire: { paykit: ["cancelStanding"], standing: ["expire"], windows: ["endStanding"] },
  CancelImmediately: { plans: ["cancelImmediately"], schedules: ["cancelNow"] },
  ScheduleCancellation: {
    paykit: ["cancelStanding"],
    standing: ["scheduleCancellation"],
    plans: ["cancelAtBoundary"],
    schedules: ["cancelGroup"],
  },
  Resume: { standing: ["resume"], plans: ["uncancel"], schedules: ["uncancelGroup"] },
  ScheduleTierChange: {
    standing: ["scheduleTier"],
    plans: ["attach"],
    balances: ["changePlan"],
    schedules: ["schedulePlan"],
  },
  WithdrawTierChange: {
    standing: ["withdrawTier"],
    plans: ["uncancel"],
    schedules: ["withdrawPhase"],
  },
  ChangeTier: {
    standing: ["changeTier"],
    plans: ["attach"],
    money: ["changeTier"],
    windows: ["changeTierCap"],
    balances: ["changePlan"],
    schedules: ["attach", "addAddOn"],
  },
  DunningRetry: { standing: ["dunningRung"] },

  // ── the clocks and the quantity ────────────────────────────────────────────
  ClosePeriod: {
    paykit: ["closePeriod"],
    standing: ["closePeriod"],
    windows: ["closePeriod"],
    plans: ["close"],
    balances: ["closePeriod"],
    controls: ["closePeriod"],
    schedules: ["close"],
    entities: ["closePeriod"],
  },
  PeriodEnded: {
    paykit: ["closePeriod"],
    standing: ["closePeriod"],
    windows: ["closePeriod"],
    plans: ["close"],
    schedules: ["close"],
    entities: ["closePeriod"],
  },
  ResetAllowance: {
    windows: ["resetWindow"],
    balances: ["closePeriod"],
    controls: ["closePeriod"],
  },
  SetQuantity: { windows: ["setQuantity"], money: ["setQuantity"] },
  SetUsage: { windows: ["setUsage"] },
  SetBillingControls: { controls: ["setControls", "clearControls"] },
  PurchaseCredits: {
    standing: ["buyTopUp"],
    windows: ["buyTopUp"],
    money: ["charge"],
  },
  RecordTopUpFailure: { standing: ["failTopUp"], windows: ["failTopUp"] },
  RetryTopUp: { standing: ["topUpRung"], windows: ["fireRung"] },
  TopUpCooldownElapsed: { windows: ["cooldownElapsed"] },

  // ── money facts ────────────────────────────────────────────────────────────
  RecordProrationInvoice: { money: ["invoiceProration"] },
  QuantityProration: { money: ["invoiceQuantity"] },
  Refund: { money: ["refund"] },
  ReverseRefund: { money: ["reverse"] },

  // ── out of every slice, with the reason ────────────────────────────────────
  AttachProviderRef: null, // provider ids, never read by `decide`
  GrantCredits: null, // goodwill, not a price or a fact about a sale
} as const satisfies Readonly<Record<string, Coverage | null>>;

/**
 * Actions that are part of a machine rather than of the protocol: the entry
 * points, the clock a policy runs on, and a scheduler's choice among queued
 * rungs. They are named here rather than in a command row.
 *
 * `entities` is the one planned exception. `attachEntity`, `archiveEntity` and
 * `transfer` are modelled by ADR 0040 before their commands land, so they have
 * no `*.command.ts` to name them. Each joins a command row the moment its
 * command exists; until then naming them here is what keeps the action
 * accounted for without inventing a row for a file that is not there. The
 * README says the same thing beside the model.
 */
const MACHINE_ACTIONS: Readonly<Record<SpecName, ReadonlyArray<string>>> = {
  paykit: ["init", "step", "tick"],
  standing: ["init", "step", "tick"],
  windows: ["init", "step", "tick", "fireAnyRung"],
  plans: ["init", "step", "tick", "cancelImmediately"],
  balances: ["init", "step", "tick"],
  controls: ["init", "step", "tick", "block", "unblock"],
  // A phase is applied by the scheduler that runs at its `startsAt`, the way a
  // rung is fired by the retry policy; the command that owns it lands with the
  // implementation, and until then it is the clock's own transition.
  schedules: ["init", "step", "tick", "applyPhase"],
  entities: ["init", "step", "tick", "attachEntity", "archiveEntity", "transfer"],
  money: ["init", "step"],
};

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
  const actions = new Map<SpecName, ReadonlySet<string>>();

  for (const name of Object.keys(SPEC_FILES)) {
    if (!isSpecName(name)) continue;
    const text = yield* fs.readFileString(path.join(root, SPEC_FILES[name]));

    actions.set(name, actionsIn(text));
  }

  const commands = commandNamesIn(yield* fs.readDirectory(path.join(root, COMMANDS)));
  const named = new Set<string>();
  const problems: Array<string> = [];

  for (const [command, coverageOfCommand] of Object.entries(SPEC_COVERAGE)) {
    if (coverageOfCommand === null) continue;

    for (const [name, actionsOfCommand] of Object.entries(coverageOfCommand)) {
      if (!isSpecName(name)) {
        problems.push(`SPEC_COVERAGE: "${command}" names unknown spec "${name}"`);
        continue;
      }

      const defined = actions.get(name);

      if (defined === undefined) {
        problems.push(`SPEC_COVERAGE: "${command}" names unknown spec "${name}"`);
        continue;
      }

      for (const action of actionsOfCommand ?? []) {
        named.add(`${name}:${action}`);

        if (!defined.has(action)) {
          problems.push(
            `SPEC_COVERAGE: "${command}" names "${action}", which ${SPEC_FILES[name]} does not define`,
          );
        }
      }
    }
  }

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

  for (const [name, defined] of actions) {
    for (const action of defined) {
      if (named.has(`${name}:${action}`) || MACHINE_ACTIONS[name].includes(action)) continue;
      problems.push(`${SPEC_FILES[name]}: action "${action}" has no row in SPEC_COVERAGE`);
    }
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new SpecCoverageViolated({ problems });
  }

  const modelled = Object.values(SPEC_COVERAGE).filter((row) => row !== null).length;

  yield* Console.log(
    `Checked ${commands.size} commands against ${actions.size} specs: ` +
      `${modelled} modelled, ${commands.size - modelled} out of every slice with a reason.`,
  );
});

coverage().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
