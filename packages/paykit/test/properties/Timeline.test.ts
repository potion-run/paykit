import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  initialSubscriptionState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import {
  type AccountEvent,
  type TimelineInput,
  appendTimeline,
  initialTimeline,
  timelineOf,
} from "../../src/Timeline.ts";
import { assertProperty } from "../support/Property.ts";
import { commandOf, decideAt, evolveAt, isAccepted, Script, start } from "./Arbitraries.ts";

const epoch = (value: DateTime.Utc): number => DateTime.toEpochMillis(value);

/**
 * Walk a generated script exactly as the other properties do, but keep the
 * envelopes: a timeline is a fold over the account's log, so the inputs are
 * what the log would have written, in order.
 */
const walkLog = (script: Script): ReadonlyArray<TimelineInput> => {
  let state: SubscriptionState = initialSubscriptionState;
  let now = start;
  const inputs: Array<TimelineInput> = [];
  for (const [index, step] of script.steps.entries()) {
    now = DateTime.add(now, { days: step.advanceDays });
    const command = commandOf(step.command, state, now);
    const decision = decideAt(state, command, now, `timeline-${index}`);
    if (!isAccepted(decision)) continue;
    for (const event of decision) {
      inputs.push({
        event: event as AccountEvent,
        envelope: { seq: inputs.length + 1, at: now },
      });
    }
    state = evolveAt(state, decision, now, `timeline-${index}`);
  }
  return inputs;
};

/**
 * The entry kind each event renders as. An event absent here moves no billing
 * fact the timeline shows, and must still advance `lastSeq`.
 */
const kindOfTag: Readonly<Record<string, string>> = {
  SubscriptionActivated: "started",
  TrialStarted: "trial",
  TierChanged: "tier",
  UsageRecorded: "usage",
  UsageReserved: "hold",
  UsageSettled: "settle",
  UsageReleased: "release",
  CreditsGranted: "credit-grant",
  CreditsPurchased: "credit-purchase",
  CreditsConsumed: "credit-spend",
  CreditsExpired: "credit-expire",
  PaymentRecorded: "payment",
  PaymentFailed: "payment-failed",
  ProrationInvoiced: "proration",
  PeriodClosed: "period",
};

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

const creditsOf = (entries: ReadonlyArray<{ readonly credits?: number }>): ReadonlyArray<number> =>
  entries.map((entry) => entry.credits ?? 0);

/**
 * The per-period rollup must be a fold of the very entries the timeline
 * carries. This checks every number in ADR 0014's claim: units, credits and
 * money per feature; grants, purchases, spends and expiries per period; and
 * the last balance an event left behind.
 */
const rollupMatchesEntries = (
  timeline: ReturnType<typeof timelineOf>,
  inputs: ReadonlyArray<TimelineInput>,
): boolean => {
  const settlesBySeq = new Map<number, { readonly released: number }>();
  for (const input of inputs) {
    if (input.event._tag === "UsageSettled") {
      settlesBySeq.set(input.envelope.seq, input.event as unknown as { released: number });
    }
  }

  for (const period of timeline.periods) {
    const entries = timeline.entries.filter(
      (entry) =>
        entry.periodStart !== undefined && epoch(entry.periodStart) === epoch(period.start),
    );

    for (const [feature, value] of Object.entries(period.features)) {
      const usage = entries.filter((entry) => entry.kind === "usage" && entry.feature === feature);
      const holds = entries.filter((entry) => entry.kind === "hold" && entry.feature === feature);
      const settled = entries.filter(
        (entry) => entry.kind === "settle" && entry.feature === feature,
      );
      const released = entries.filter(
        (entry) => entry.kind === "release" && entry.feature === feature,
      );

      if (value.units !== sum(usage.map((entry) => entry.amount ?? 0))) return false;
      if (value.credits !== sum(creditsOf(usage))) return false;
      if (value.charge !== sum(usage.map((entry) => entry.charge ?? 0))) return false;
      if (value.held !== sum(holds.map((entry) => entry.amount ?? 0))) return false;
      if (value.settled !== sum(settled.map((entry) => entry.amount ?? 0))) return false;
      // A settle returns the units it did not bill in the same event, so the
      // period's `released` is the releases plus every settle's remainder.
      const remaining = sum(settled.map((entry) => settlesBySeq.get(entry.seq)?.released ?? 0));
      if (value.released !== sum(released.map((entry) => entry.amount ?? 0)) + remaining) {
        return false;
      }
    }

    const granted = entries.filter(
      (entry) =>
        entry.kind === "started" || entry.kind === "trial" || entry.kind === "credit-grant",
    );
    const purchased = entries.filter((entry) => entry.kind === "credit-purchase");
    const spent = entries.filter(
      (entry) => entry.kind === "usage" || entry.kind === "credit-spend",
    );
    const expired = entries.filter((entry) => entry.kind === "credit-expire");

    if (period.credits.granted !== sum(creditsOf(granted))) return false;
    if (period.credits.purchased !== sum(creditsOf(purchased))) return false;
    if (period.credits.spent !== sum(creditsOf(spent))) return false;
    if (period.credits.expired !== sum(creditsOf(expired))) return false;

    const balanced = entries.filter((entry) => entry.creditsAfter !== undefined);
    const last = balanced[balanced.length - 1];
    if (last !== undefined && period.credits.balanceAfter !== last.creditsAfter) {
      return false;
    }
  }
  return true;
};

const entriesMatchLog = (
  timeline: ReturnType<typeof timelineOf>,
  inputs: ReadonlyArray<TimelineInput>,
): boolean => {
  const bySeq = new Map(inputs.map((input) => [input.envelope.seq, input.event]));
  const expected = new Set(
    inputs
      .filter((input) => kindOfTag[input.event._tag] !== undefined)
      .map((input) => input.envelope.seq),
  );
  const seen = new Set<number>();
  let previousSeq = 0;
  for (const entry of timeline.entries) {
    if (entry.seq <= previousSeq) return false;
    previousSeq = entry.seq;
    const event = bySeq.get(entry.seq);
    if (event === undefined) return false;
    if (kindOfTag[event._tag] !== entry.kind) return false;
    seen.add(entry.seq);
  }
  // One entry per billing fact, no more and no fewer.
  if (seen.size !== expected.size) return false;
  for (const seq of expected) if (!seen.has(seq)) return false;
  return true;
};

describe("a timeline is a fold over the account log", () => {
  it.effect("every entry is the log's, in order, and every rollup is those entries", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        const inputs = walkLog(script);
        const timeline = timelineOf(inputs);

        if (timeline.lastSeq !== inputs.length) return false;
        if (!entriesMatchLog(timeline, inputs)) return false;
        if (!rollupMatchesEntries(timeline, inputs)) return false;

        // Folding one input at a time is the same fold, and a redelivery of
        // any event the fold already saw is the same timeline object rather
        // than a second entry.
        const incremental = inputs.reduce(appendTimeline, initialTimeline);
        if (JSON.stringify(incremental) !== JSON.stringify(timeline)) return false;
        for (const input of inputs) {
          if (appendTimeline(timeline, input) !== timeline) return false;
        }
        return true;
      },
      { runs: 100, size: 40 },
    ),
  );

  it.effect("splitting the log anywhere folds to the same timeline", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          script: Script,
          /** A fraction of the log to fold first; the rest is replayed after. */
          split: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
        }),
      ),
      ({ script, split }) => {
        const inputs = walkLog(script);
        const at = Math.floor((inputs.length * split) / 100);
        const first = timelineOf(inputs.slice(0, at));
        const resumed = inputs.slice(at).reduce(appendTimeline, first);
        return JSON.stringify(resumed) === JSON.stringify(timelineOf(inputs));
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("an event that renders nothing still advances the cursor", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        const inputs = walkLog(script);
        const timeline = timelineOf(inputs);
        for (const input of inputs) {
          if (kindOfTag[input.event._tag] !== undefined) continue;
          const before = timelineOf(
            inputs.filter((entry) => entry.envelope.seq < input.envelope.seq),
          );
          const after = appendTimeline(before, input);
          if (after.lastSeq !== input.envelope.seq) return false;
          if (after.entries.length !== before.entries.length) return false;
        }
        return timeline.lastSeq === inputs.length;
      },
      { runs: 60, size: 20 },
    ),
  );
});
