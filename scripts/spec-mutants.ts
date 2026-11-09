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

const MUTANTS: ReadonlyArray<Mutant> = [
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

class MutantSurvived extends Data.TaggedError("MutantSurvived")<{
  readonly problems: ReadonlyArray<string>;
}> {}

const runQuint = (file: string, invariant: string) =>
  Effect.sync(() =>
    spawnSync(
      "quint",
      ["run", file, `--invariant=${invariant}`, "--max-steps=30", "--verbosity=0"],
      {
        encoding: "utf8",
      },
    ),
  );

const mutants = Effect.fn("SpecMutants.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const spec = yield* fs.readFileString(path.join(root, SPEC));
  const problems: Array<string> = [];

  for (const mutant of MUTANTS) {
    const occurrences = spec.split(mutant.from).length - 1;

    if (occurrences !== 1) {
      problems.push(
        `${mutant.name}: anchor occurs ${occurrences} time(s) in ${SPEC} — re-anchor the mutant`,
      );
      continue;
    }

    // The module is named after its file, so the mutant keeps the stem and
    // changes only the directory.
    const directory = path.join(root, SCRATCH, mutant.name);
    const file = path.join(directory, "paykit.qnt");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(file, spec.replace(mutant.from, mutant.to));

    const result = yield* runQuint(file, mutant.invariant);

    if (result.error !== undefined) {
      return yield* Effect.die(result.error);
    }

    // A non-zero exit is the point: the invariant found the mutant. A zero exit
    // means the rule changed and nothing noticed.
    if (result.status === 0) {
      problems.push(
        `${mutant.name}: ${mutant.invariant} still holds — ${mutant.why} went unnoticed`,
      );
    }
  }

  if (problems.length > 0) {
    yield* Console.error(problems.map((problem) => `  ${problem}`).join("\n"));

    return yield* new MutantSurvived({ problems });
  }

  yield* Console.log(
    `Killed ${MUTANTS.length} mutants: every invariant above fails when its rule is broken.`,
  );
});

mutants().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
