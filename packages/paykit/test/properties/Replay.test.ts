import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import { assertProperty } from "../support/Property.ts";
import { canonical, foldAt, Script, walk } from "./Arbitraries.ts";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

describe("replay", () => {
  it.effect("folds a generated command sequence back to the state it walked", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        const { state, events, now } = walk(script);
        const rebuilt = foldAt(events, now);
        if (!same(canonical(rebuilt), canonical(state))) return false;

        // A counter is a fold of the events since the last reset, not a number
        // the state remembered independently. Activation and trial start also
        // begin a fresh period, so they are reset points too.
        const tags = events.map((event) => event._tag);
        const lastReset = Math.max(
          tags.lastIndexOf("UsageReset"),
          tags.lastIndexOf("SubscriptionActivated"),
          tags.lastIndexOf("TrialStarted"),
        );
        const recorded = events
          .slice(lastReset + 1)
          .filter(
            (event) =>
              event._tag === "UsageRecorded" &&
              (event as unknown as { readonly feature: string }).feature === "messages",
          )
          .reduce(
            (sum, event) => sum + (event as unknown as { readonly amount: number }).amount,
            0,
          );
        if (state._tag !== "Subscribed") return true;
        if ((state.usage.messages ?? 0) !== recorded) return false;

        // The credit pool is a fold too: every event that moves it carries the
        // balance it left, so the last such event must be the state's balance.
        const balances = events.flatMap((event) => {
          const value = event as unknown as Readonly<Record<string, unknown>>;
          switch (event._tag) {
            case "SubscriptionActivated":
            case "TrialStarted":
            case "TierChanged":
              return [value.credits as number];
            case "UsageRecorded":
              return [value.creditsAfter as number];
            case "CreditsGranted":
            case "CreditsPurchased":
            case "CreditsConsumed":
            case "CreditsExpired":
              return [value.balanceAfter as number];
            default:
              return [];
          }
        });
        return state.credits === (balances.at(-1) ?? 0);
      },
      { runs: 60, size: 50 },
    ),
  );

  it.effect("walks the same generated script to the same state twice", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        const first = walk(script);
        const second = walk(script);
        return (
          same(canonical(first.state), canonical(second.state)) && same(first.events, second.events)
        );
      },
      { runs: 60, size: 50 },
    ),
  );

  it("a script can activate a standing and record usage", () => {
    // A seed with an activation and a Track, so the generated space is known
    // to reach the interesting part of the state machine.
    const script = {
      steps: [
        { command: { _tag: "Subscribe", tier: "free" }, advanceDays: 0 },
        { command: { _tag: "TrackUsage", amount: 10 }, advanceDays: 1 },
      ],
    } as const;
    const { state } = walk(script);
    expect(state._tag).toBe("Subscribed");
    if (state._tag === "Subscribed") expect(state.usage.messages).toBe(10);
  });
});
