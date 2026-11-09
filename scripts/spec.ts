// Runs the Quint model gate: typecheck every module, then either simulate every
// invariant with its witnesses (`spec`) or run the named scenarios (`spec:test`).
//
// The models are one per protocol:
//   paykit.qnt     the spend path
//   standing.qnt   the phase machine
//   windows.qnt    the clocks the period does not own, and the quantity
//   balances.qnt   the sources behind one count, and the order they are spent
//   money.qnt      refunds, reversals and proration invoices
//
// `--tests` runs `quint test` instead of `quint run`; both paths typecheck
// first, so a scenario that references a dead action fails before it runs.
import { spawnSync } from "node:child_process";

interface Spec {
  /** The main module file, and the module name `quint run` reports. */
  readonly file: string;
  /** The invariants this module owns. */
  readonly invariants: ReadonlyArray<string>;
  /** The witnesses that prove its major actions are reachable. */
  readonly witnesses: ReadonlyArray<string>;
  /** The named-scenario module, run by `spec:test`. */
  readonly tests: string;
  /** The module name `quint test` imports. */
  readonly testMain: string;
  /** How deep a simulation should go. */
  readonly maxSteps: number;
}

const SPECS: ReadonlyArray<Spec> = [
  {
    file: "specs/paykit/paykit.qnt",
    invariants: ["paykitInvariant"],
    witnesses: [
      "messagesUsed",
      "requestsBilledPastIncluded",
      "creditsSpentByUsage",
      "creditsConsumedDirectly",
      "holdOpen",
      "holdSettled",
      "holdReleasedWhileActive",
      "holdReleasedWhileCanceled",
      "holdExpired",
      "standingInGrace",
      "periodRolled",
      "carriedForward",
      "creditsExpiredAtBoundary",
      "keptCounterSurvivesClose",
    ],
    tests: "specs/paykit/paykit_test.qnt",
    testMain: "paykit_test",
    maxSteps: 40,
  },
  {
    file: "specs/paykit/standing.qnt",
    invariants: ["standingInvariant"],
    witnesses: [
      "trialing",
      "active",
      "inGrace",
      "expired",
      "canceled",
      "trialExtended",
      "periodRolled",
      "cancellationScheduled",
      "tierScheduled",
      "tierChanged",
      "pendingApplied",
      "dunningRunStarted",
      "dunningRungFired",
      "topUpBudgetStarted",
      "topUpRungFired",
      "creditsSpent",
      "lifetimeCreditsSpent",
      "lifetimeCreditsSurviveClose",
      "lifetimeCreditsSurvivePendingChange",
    ],
    tests: "specs/paykit/standing_test.qnt",
    testMain: "standing_test",
    maxSteps: 40,
  },
  {
    file: "specs/paykit/windows.qnt",
    invariants: ["windowsInvariant"],
    witnesses: [
      "dailyWindowReset",
      "periodWindowReset",
      "lateReset",
      "quantitySet",
      "usageSet",
      "seatBalanceNegative",
      "quantityRaisedByTier",
      "topUpFailed",
      "rungScheduled",
      "rungFired",
      "cooldownOpened",
      "cooldownCleared",
      "ended",
      "seatSurvivedClose",
    ],
    tests: "specs/paykit/windows_test.qnt",
    testMain: "windows_test",
    maxSteps: 20,
  },
  {
    file: "specs/paykit/plans.qnt",
    invariants: ["plansInvariant"],
    witnesses: [
      "active",
      "upgraded",
      "downgradeScheduled",
      "pendingApplied",
      "cancellationScheduled",
      "canceledAtBoundary",
      "canceledImmediately",
      "reactivated",
      "uncanceled",
    ],
    tests: "specs/paykit/plans_test.qnt",
    testMain: "plans_test",
    maxSteps: 30,
  },
  {
    file: "specs/paykit/balances.qnt",
    invariants: ["balancesInvariant"],
    witnesses: [
      "granted",
      "grantedLifetime",
      "spentPlan",
      "spentGrant",
      "rolledOver",
      "closed",
      "changedPlan",
      "expiredGrant",
      "fullySpent",
      "lifetimeSurvivedClose",
    ],
    tests: "specs/paykit/balances_test.qnt",
    testMain: "balances_test",
    maxSteps: 30,
  },
  {
    file: "specs/paykit/money.qnt",
    invariants: ["moneyInvariant"],
    witnesses: [
      "refundRecorded",
      "refundPartiallyReversed",
      "refundFullyReversed",
      "prorationOwed",
      "prorationBilled",
      "prorationReplaced",
      "quantityCreditRecorded",
      "quantityInvoiceRecorded",
      "quantityCreditUninvoiced",
    ],
    tests: "specs/paykit/money_test.qnt",
    testMain: "money_test",
    maxSteps: 30,
  },
];

const onlyTests = process.argv.includes("--tests");

const run = (args: ReadonlyArray<string>): void => {
  const result = spawnSync("quint", args, { stdio: "inherit" });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
};

for (const spec of SPECS) {
  run(["typecheck", spec.file]);
  run(["typecheck", spec.tests]);
}

if (onlyTests) {
  for (const spec of SPECS) {
    run(["test", spec.tests, `--main=${spec.testMain}`]);
  }
} else {
  for (const spec of SPECS) {
    run([
      "run",
      spec.file,
      ...spec.invariants.map((invariant) => `--invariant=${invariant}`),
      ...spec.witnesses.map((witness) => `--witnesses=${witness}`),
      `--max-steps=${spec.maxSteps}`,
    ]);
  }
}
