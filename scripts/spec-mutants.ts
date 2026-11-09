// Inverts one rule of the model at a time and proves the named invariant
// notices.
//
//   pnpm spec:mutants
//
// A model that has never failed is a model nobody has tested: an invariant can
// be true simply because nothing in the model can move the counter it watches.
// Each mutant below is a plausible way to get the rule wrong — a settle that
// forgets to return what it did not bill, a hold that reserves nothing — and the
// gate fails when a mutant *survives*, because that means the invariant beside it
// is not load-bearing.
//
// The mutation is a textual replacement, so a renamed rule breaks the anchor
// rather than silently mutating the wrong line: the anchor must occur exactly
// once, and a mutant whose anchor is gone is reported as stale.
import { spawnSync } from "node:child_process";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SPEC = "specs/paykit/paykit.qnt";
const SCRATCH = ".tmp/spec-mutants";

/** One way to get the model wrong, and the invariant that has to catch it. */
interface Mutant {
  readonly name: string;
  readonly invariant: string;
  readonly from: string;
  readonly to: string;
  readonly why: string;
}

const PAYKIT_MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "settle-drops-the-return",
    invariant: "countedConserved",
    from:
      "      spent: if (creditPriced) s.spent + spent else s.spent,\n" +
      "      remaining: s.remaining.set(hold.feature, s.remaining.get(hold.feature) + returned),",
    to: "      spent: if (creditPriced) s.spent + spent else s.spent,\n      remaining: s.remaining,",
    why: "a settle that does not return the units it did not bill",
  },
  {
    name: "hold-reserves-nothing",
    invariant: "countedConserved",
    from: "remaining: s.remaining.set(feature, s.remaining.get(feature) - requested),",
    to: "remaining: s.remaining,",
    why: "a hold that leaves the units it reserves spendable",
  },
  {
    name: "settle-a-closed-hold",
    invariant: "countedConserved",
    from: "      hold.status == Open,\n      allowsUsage(s.status),",
    to: "      true,\n      allowsUsage(s.status),",
    why: "a settle that bills a hold somebody already released",
  },
  {
    name: "release-a-settled-hold",
    invariant: "countedConserved",
    from: "  pure def canRelease(s: State, id: HoldId): bool =\n    s.holds.get(id).status == Open",
    to: "  pure def canRelease(s: State, id: HoldId): bool =\n    s.holds.get(id).status != Available",
    why: "a release that gives back units a settle already billed",
  },
  {
    name: "consume-forgets-the-history",
    invariant: "creditPoolConserved",
    from: "    consumed: s.consumed + amount,",
    to: "    consumed: s.consumed,",
    why: "a direct consume that the pool's conservation law cannot see",
  },
  {
    name: "credit-spend-keeps-the-credits",
    invariant: "creditPoolConserved",
    from: "          credits: s.credits - cost,",
    to: "          credits: s.credits,",
    why: "a credit-priced usage that spends no credits",
  },
  {
    name: "hold-cost-ignores-the-rate",
    invariant: "holdCostIsAmountTimesRate",
    from: "        cost: amount * rate,",
    to: "        cost: amount,",
    why: "a hold that reserves units where the pool charges credits",
  },
  {
    name: "tick-passes-the-deadline",
    invariant: "noHoldPastDeadline",
    from: "    state.now + 1 <= nextDeadline(state),",
    to: "    true,",
    why: "a clock that walks past a deadline with a hold still open",
  },
  {
    name: "tick-passes-the-boundary",
    invariant: "noPeriodPastEnd",
    from: "    state.now + 1 <= nextDeadline(state),",
    to: "    state.now + 1 <= nextHoldDeadline(state.holds),",
    why: "a clock that walks past the boundary instead of stopping for the close",
  },
  {
    name: "blocking-allows-past-remaining",
    invariant: "blockingNeverOversubscribed",
    from: "    amount > 0 and (allowance.overage == Bill or amount <= remaining)",
    to: "    amount > 0",
    why: "a blocking allowance that accepts more than it has",
  },
  {
    name: "close-drops-the-carry",
    invariant: "countedConserved",
    from: "        acc.set(feature, closeCarry(s.allowances.get(feature), s.remaining.get(feature)))),",
    to: "        acc.set(feature, 0)),",
    why: "a close that rolls the remainder into `remaining` but not into `carried`",
  },
  {
    name: "close-keeps-the-debt",
    invariant: "countedConserved",
    from: "    else allowance.included + closeCarry(allowance, remaining)",
    to: "    else remaining",
    why: "a close that carries an overdrawn allowance's debt into the next period",
  },
  {
    name: "close-carries-two-periods",
    invariant: "carriedIsBounded",
    from: "    clamp(remaining, 0, carriedCapOf(allowance))",
    to: "    if (remaining < 0) 0 else remaining",
    why: "a close that exceeds the carry cap",
  },
  {
    name: "close-keeps-the-counter",
    invariant: "countedConserved",
    from: "        if (isKeptOnClose(s.allowances.get(feature))) acc else acc.set(feature, 0)),",
    to: "        acc),",
    why: "a close that does not zero the counters it resets",
  },
  {
    name: "close-zeros-a-kept-counter",
    invariant: "countedConserved",
    from: "        if (isKeptOnClose(s.allowances.get(feature))) acc else acc.set(feature, 0)),",
    to: "        acc.set(feature, 0)),",
    why: 'a close that resets a `resets: "never"` counter while keeping its remainder',
  },
  {
    name: "close-keeps-open-holds",
    invariant: "countedConserved",
    from: "        if (dropped.contains(id)) acc.set(id, { ...s.holds.get(id), status: Available }) else acc),",
    to: "        acc),",
    why: "a close that drops a feature's counters but keeps its open holds",
  },
  {
    name: "close-forgets-the-expiry",
    invariant: "creditPoolConserved",
    from: "      expired: s.expired + s.credits,",
    to: "      expired: s.expired,",
    why: "a close that empties the pool without recording what it expired",
  },
];

const STANDING_MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "close-expires-a-lifetime-pool",
    invariant: "creditPoolConserved",
    from: "      planCredits: closePlanCredits(state, pending),",
    to: "      planCredits: closePlanCredits(state, pending),\n      lifetimeCredits: 0,",
    why: "a close that empties a lifetime source without recording a spend or an expiry",
  },
  {
    name: "pending-change-keeps-the-old-plan-pool",
    invariant: "creditPoolConserved",
    from: "  pure def closePlanCredits(state: State, pending: bool): int =\n    if (pending) grantOf(pendingTierOf(state.pending)) else 0",
    to: "  pure def closePlanCredits(state: State, pending: bool): int =\n    if (pending) state.planCredits else 0",
    why: "a scheduled change that keeps the old plan pool while also granting the new one",
  },
  {
    name: "tick-passes-the-grace-deadline",
    invariant: "noGracePastDeadline",
    from: "    state.now + 1 <= nextDeadline(state),",
    to:
      "    (if (state.phase == Grace) state.now + 1 <= state.graceEnd + 1\n" +
      "     else state.now + 1 <= nextDeadline(state)),",
    why: "a clock that walks one step past a grace deadline",
  },
];

const WINDOWS_MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "seat-balance-ignores-occupancy",
    invariant: "seatBalanceIsDerived",
    from: "  pure def seatBalance(seats: Seats): int = seats.purchased - seats.occupied",
    to: "  pure def seatBalance(seats: Seats): int = seats.purchased",
    why: "a seat balance that counts the purchase and forgets the occupied seats",
  },
  {
    name: "seat-check-allows-negative",
    invariant: "seatCheckAgreesWithBalance",
    from: "  pure def canCheckSeats(seats: Seats, required: int): bool =\n    required >= 0 and seatBalance(seats) >= required",
    to: "  pure def canCheckSeats(seats: Seats, required: int): bool =\n    required >= 0",
    why: "a seat check that allows new occupancy while the balance is negative",
  },
  {
    name: "reset-does-not-advance-the-boundary",
    invariant: "boundariesAdvance",
    from: "    boundary: at + window.every,",
    to: "    boundary: window.boundary,",
    why: "a reset that moves the last-reset instant but leaves the next boundary behind",
  },
  {
    name: "track-spends-past-a-blocking-count",
    invariant: "blockingCountsBounded",
    from: "      not(window.blocking) or amount <= window.remaining,",
    to: "      true,",
    why: "a blocking count that accepts more than it has",
  },
  {
    name: "failure-keeps-the-old-rung",
    invariant: "rungsBelongToTheBudget",
    from:
      "        if (nextAttempt <= TOP_UP_BUDGET)\n" +
      "          Set({ episode: nextEpisode, attempt: nextAttempt, at: state.now + TOP_UP_EVERY })\n" +
      "        else Set(),",
    to: "        state.rungs.union(Set({ episode: nextEpisode, attempt: nextAttempt, at: state.now + TOP_UP_EVERY })),",
    why: "a retry queue that keeps the rung of the episode a new failure ended",
  },
  {
    name: "purchase-keeps-the-old-rungs",
    invariant: "rungsBelongToTheBudget",
    from:
      "    topUpAttempts: 0,\n" +
      "    rungs: Set(),\n" +
      "    cooldown: Cooldown({ until: state.now + COOLDOWN_LENGTH }),",
    to:
      "    topUpAttempts: 0,\n" +
      "    rungs: state.rungs,\n" +
      "    cooldown: Cooldown({ until: state.now + COOLDOWN_LENGTH }),",
    why: "a success that resets the budget but leaves a rung from the old episode queued",
  },
];

const MONEY_MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "refund-does-not-move-the-total",
    invariant: "refundedIsOutstanding",
    from: "    refunded: state.refunded + amount,",
    to: "    refunded: state.refunded,",
    why: "a refund record the currency total does not see",
  },
  {
    name: "reversal-does-not-move-the-total",
    invariant: "refundedIsOutstanding",
    from: "      refunded: state.refunded - amount,",
    to: "      refunded: state.refunded,",
    why: "a reversal the currency total does not see",
  },
  {
    name: "refund-past-the-charge",
    invariant: "refundsCoveredByCharges",
    from: "    state.refunded + amount <= state.charged,",
    to: "    true,",
    why: "a refund ceiling that ignores what was charged",
  },
  {
    name: "reversal-past-the-refund",
    invariant: "reversalsBounded",
    from: "    amount > 0 and amount <= outstandingOf(record)",
    to: "    amount > 0",
    why: "a reversal larger than the refund it names",
  },
  {
    name: "quantity-credit-invoiced",
    invariant: "quantityCreditsNeverInvoiced",
    from:
      "    entry.present\n" +
      "      and not(entry.invoiced)\n" +
      "      and entry.due > 0\n" +
      "      and entry.due == amount",
    to: "    entry.present\n" + "      and not(entry.invoiced)",
    why: "a seat reduction's credit booked as money to collect",
  },
  {
    name: "quantity-invoice-ignores-the-due",
    invariant: "quantityInvoicesMatchDue",
    from:
      "    entry.present\n" +
      "      and not(entry.invoiced)\n" +
      "      and entry.due > 0\n" +
      "      and entry.due == amount",
    to: "    entry.present\n" + "      and not(entry.invoiced)\n" + "      and entry.due > 0",
    why: "a quantity invoice for an amount other than the change's due",
  },
  {
    name: "proration-invoice-ignores-the-id",
    invariant: "billedProrationIsCurrent",
    from: "      | Owed(entry) => entry.id == id and entry.due == amount and entry.due > 0",
    to: "      | Owed(entry) => entry.due == amount and entry.due > 0",
    why: "an invoice for an old tier change settling the current proration",
  },
];

/** One model, its file, the depth a mutation run needs, and its mutants. */
interface SpecMutants {
  readonly file: string;
  readonly maxSteps: number;
  readonly mutants: ReadonlyArray<Mutant>;
}

const PLANS_MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "upgrade-is-scheduled",
    invariant: "scheduledChangeIsADowngrade",
    from: "    else if (isUpgrade(state.plan, plan)) Upgrade",
    to: "    else if (isUpgrade(state.plan, plan)) Schedule",
    why: "a more expensive plan left waiting for the boundary instead of applied now",
  },
  {
    name: "schedule-the-current-plan",
    invariant: "scheduledChangeIsADowngrade",
    from: "          pending: Pending(plan),",
    to: "          pending: Pending(state.plan),",
    why: "a scheduled change that names the plan already running",
  },
  {
    name: "cancellation-keeps-the-pending-plan",
    invariant: "terminalHasNoIntent",
    from:
      "        phase: Canceled,\n" +
      "        pending: NoChange,\n" +
      "        cancelAtPeriodEnd: false,\n" +
      "        closes: state.closes + 1,",
    to:
      "        phase: Canceled,\n" +
      "        pending: state.pending,\n" +
      "        cancelAtPeriodEnd: false,\n" +
      "        closes: state.closes + 1,",
    why: "a cancellation that ends the plan but leaves the pending change alive",
  },
  {
    name: "immediate-cancel-keeps-the-pending-plan",
    invariant: "terminalHasNoIntent",
    from:
      "      phase: Canceled,\n" +
      "      pending: NoChange,\n" +
      "      cancelAtPeriodEnd: false,\n" +
      "      immediateCancels: state.immediateCancels + 1,",
    to:
      "      phase: Canceled,\n" +
      "      pending: state.pending,\n" +
      "      cancelAtPeriodEnd: false,\n" +
      "      immediateCancels: state.immediateCancels + 1,",
    why: "an immediate cancellation that leaves a future plan intent on a terminal plan",
  },
];

const SPECS: ReadonlyArray<SpecMutants> = [
  { file: SPEC, maxSteps: 30, mutants: PAYKIT_MUTANTS },
  { file: "specs/paykit/standing.qnt", maxSteps: 30, mutants: STANDING_MUTANTS },
  { file: "specs/paykit/windows.qnt", maxSteps: 20, mutants: WINDOWS_MUTANTS },
  { file: "specs/paykit/plans.qnt", maxSteps: 30, mutants: PLANS_MUTANTS },
  { file: "specs/paykit/money.qnt", maxSteps: 30, mutants: MONEY_MUTANTS },
];

class MutantSurvived extends Data.TaggedError("MutantSurvived")<{
  readonly problems: ReadonlyArray<string>;
}> {}

const runQuint = (file: string, invariant: string, maxSteps: number) =>
  Effect.sync(() =>
    spawnSync(
      "quint",
      ["run", file, `--invariant=${invariant}`, `--max-steps=${maxSteps}`, "--verbosity=0"],
      {
        encoding: "utf8",
      },
    ),
  );

const mutants = Effect.fn("SpecMutants.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const problems: Array<string> = [];
  let killed = 0;

  for (const spec of SPECS) {
    const text = yield* fs.readFileString(path.join(root, spec.file));
    const name = path.basename(spec.file);

    for (const mutant of spec.mutants) {
      const occurrences = text.split(mutant.from).length - 1;

      if (occurrences !== 1) {
        problems.push(
          `${mutant.name}: anchor occurs ${occurrences} time(s) in ${spec.file} — re-anchor the mutant`,
        );
        continue;
      }

      // The module is named after its file, so the mutant keeps the stem and
      // changes only the directory.
      const directory = path.join(root, SCRATCH, name.replace(/\.qnt$/, ""), mutant.name);
      const file = path.join(directory, name);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(file, text.replace(mutant.from, mutant.to));

      const result = yield* runQuint(file, mutant.invariant, spec.maxSteps);

      if (result.error !== undefined) {
        return yield* Effect.die(result.error);
      }

      // A non-zero exit is the point: the invariant found the mutant. A zero
      // exit means the rule changed and nothing noticed.
      if (result.status === 0) {
        problems.push(
          `${mutant.name}: ${mutant.invariant} still holds — ${mutant.why} went unnoticed`,
        );
      } else {
        killed++;
      }
    }
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new MutantSurvived({ problems });
  }

  yield* Console.log(
    `Killed ${killed} mutants across ${SPECS.length} models: every invariant above fails when its rule is broken.`,
  );
});

mutants().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
