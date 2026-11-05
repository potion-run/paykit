import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import { isFlagGrant, type Allowance } from "../../src/Allowance.ts";
import {
  includedRemainingOf,
  initialSubscriptionState,
  prepaidCreditsOf,
  remainingOf,
  reservedCreditsOf,
  reservedOf,
  usedOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import { commandOf, decideAt, evolveAt, isAccepted, Script, start } from "./Arbitraries.ts";

type Event = Readonly<{ readonly _tag: string }>;

/**
 * The allowance each feature is conserving this period: what the tier
 * included, plus what the last rollover carried. Activation, trial start and a
 * tier change begin a fresh base; a `UsageReset` starts the next one.
 */
const updateBases = (
  bases: Map<string, number | null>,
  events: ReadonlyArray<Event>,
  state: SubscriptionState,
): void => {
  for (const event of events) {
    switch (event._tag) {
      case "SubscriptionActivated":
      case "TrialStarted":
      case "TierChanged": {
        const allowances = (event as unknown as { readonly allowances: Record<string, Allowance> })
          .allowances;
        for (const [feature, allowance] of Object.entries(allowances)) {
          bases.set(feature, includedRemainingOf(allowance));
        }
        break;
      }
      case "UsageReset": {
        const reset = event as unknown as {
          readonly remaining: Record<string, number | null>;
          readonly carried: Record<string, number>;
        };
        if (state._tag !== "Subscribed") break;
        for (const feature of Object.keys(reset.remaining)) {
          const allowance = state.allowances[feature];
          if (allowance === undefined) continue;
          const included = includedRemainingOf(allowance);
          bases.set(feature, included === null ? null : included + (reset.carried[feature] ?? 0));
        }
        break;
      }
    }
  }
};

/**
 * The numbers a standing may never contradict, whatever command produced it:
 * a pool that does not go negative and still covers every open hold, a hold
 * that is a fold of the holds themselves, and a counted allowance whose use,
 * reservations and remainder still add up to what the period began with.
 */
const invariantsHold = (
  state: SubscriptionState,
  bases: ReadonlyMap<string, number | null>,
): boolean => {
  if (state._tag !== "Subscribed") {
    const credits = state.credits ?? 0;
    const prepaid = state.prepaidCredits ?? 0;
    if (credits < 0 || prepaid < 0 || prepaid > credits) return false;
    return Object.values(state.usage ?? {}).every((used) => used >= 0);
  }

  // The pool covers every open hold. A spend that ignores reservations would
  // otherwise leave settle with credits it cannot bill.
  if (state.credits < 0) return false;
  if (state.credits < reservedCreditsOf(state)) return false;
  // A one-off pack is a part of the pool, never more than the pool and never
  // negative, so a period close can subtract the plan's credits and leave it.
  const prepaid = prepaidCreditsOf(state);
  if (prepaid < 0 || prepaid > state.credits) return false;

  for (const [feature, allowance] of Object.entries(state.allowances)) {
    const used = usedOf(state, feature);
    const reserved = reservedOf(state, feature);
    const remaining = remainingOf(state, feature);
    if (used < 0 || reserved < 0) return false;

    if (isFlagGrant(allowance)) {
      // A flag is granted, not counted: no usage, no reservation, no count.
      if (remaining !== null) return false;
      if (used !== 0 || reserved !== 0) return false;
      continue;
    }

    if (allowance.included === "unlimited") {
      // An unbounded allowance has no count to spend down.
      if (remaining !== null) return false;
      continue;
    }

    if (remaining === null) return false;
    // A blocking allowance never spends past zero.
    if (allowance.overage === "block" && remaining < 0) return false;
    // A cap is a ceiling on the units a period may bill, holds included.
    if (allowance.cap !== undefined && used + reserved > allowance.included + allowance.cap) {
      return false;
    }
    // Use, reservations and the remainder are one count: none of them may
    // drift from what the period began with.
    const base = bases.get(feature);
    if (base !== undefined && base !== null && used + reserved + remaining !== base) return false;
  }

  for (const feature of Object.keys(state.rates)) {
    if (usedOf(state, feature) < 0) return false;
  }

  return true;
};

describe("cross-family invariants", () => {
  it.effect("every generated script keeps the pool and every allowance conserved", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        let state: SubscriptionState = initialSubscriptionState;
        let now = start;
        const bases = new Map<string, number | null>();
        if (!invariantsHold(state, bases)) return false;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `invariant-${index}`);
          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, now, `invariant-${index}`);
          updateBases(bases, decision, state);
          if (!invariantsHold(state, bases)) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});
