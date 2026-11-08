import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance, carryCapOf, type Allowance, type Resets } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { AllowanceReset, ResetAllowance } from "../../src/Subscription/ResetAllowance.command.ts";
import { resetWindowsOf } from "../../src/Subscription/Standing.ts";
import {
  includedRemainingOf,
  nextResetAt,
  periodTiedReset,
  resetOf,
  resetOfFeature,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedIn } from "./Arbitraries.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const AllResets = Schema.Literals([
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "semi_annual",
  "annual",
  "never",
]);

type AllResets = typeof AllResets.Type;

const scheduleOf = (resets: AllResets, every: number) => ({ resets, resetEvery: every });

const everyIntervalOf = (allowance: { readonly resets: Resets; readonly resetEvery?: number }) => {
  const every = allowance.resetEvery ?? 1;

  switch (allowance.resets) {
    case "never":
      return null;
    case "hour":
      return { hours: every };
    case "day":
      return { days: every };
    case "week":
      return { weeks: every };
    case "month":
      return { months: every };
    case "quarter":
      return { months: 3 * every };
    case "semi_annual":
      return { months: 6 * every };
    case "annual":
      return { years: every };
  }
};

const daily = tier({
  id: "daily",
  price,
  grants: [allowance(messages, { included: 10, resets: "day" })],
});

const fourHourly = tier({
  id: "four-hourly",
  price,
  grants: [allowance(messages, { included: 10, resets: "hour", resetEvery: 4 })],
});

const quarterly = tier({
  id: "quarterly",
  price,
  grants: [allowance(messages, { included: 10, resets: "quarter" })],
});

const monthly = tier({
  id: "monthly",
  price,
  grants: [allowance(messages, { included: 10, resets: "month" })],
});

const dailyCarry = tier({
  id: "daily-carry",
  price,
  grants: [allowance(messages, { included: 10, resets: "day", carryOver: true, carryCap: 5 })],
});

const monthlyCarry = tier({
  id: "monthly-carry",
  price,
  grants: [allowance(messages, { included: 10, carryOver: true, carryCap: 5 })],
});

const schedules = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [daily, fourHourly, quarterly, monthly, dailyCarry, monthlyCarry],
  }),
);

const Stock = Schema.Literals([
  "daily",
  "four-hourly",
  "quarterly",
  "monthly",
  "daily-carry",
  "monthly-carry",
]);

type Stock = typeof Stock.Type;

/** The tiers whose boundary the period does not own. */
const WindowStock = Schema.Literals(["daily", "four-hourly", "quarterly", "daily-carry"]);

type WindowStock = typeof WindowStock.Type;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const stateAt = (built: Allowance, remaining: number | null | undefined): SubscribedState =>
  ({
    allowances: { messages: built },
    remaining: remaining === undefined ? {} : { messages: remaining },
  }) as unknown as SubscribedState;

const recordedAmount = (
  state: ReadonlyArray<{ readonly _tag: string; readonly feature?: string }>,
): number => {
  const recorded = state.find((event) => event._tag === "UsageRecorded");

  return recorded === undefined ? 0 : ((recorded as { amount?: number }).amount ?? 0);
};

describe("a reset runs on its own schedule", () => {
  /**
   * The boundary belongs to the allowance's own cadence and multiplier: it is
   * always after the instant it is computed from, `resetEvery` multiplies the
   * interval, and only a monthly or annual allowance with no multiplier is the
   * standing's period. Everything else owns a window the close must not touch.
   */
  it.effect("a boundary follows its interval, moves forward, and only some are the period", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          resets: AllResets,
          every: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
          fromDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 400 }))),
        }),
      ),
      ({ resets, every, fromDays }) => {
        const from = DateTime.add(start, { days: fromDays });
        const schedule = scheduleOf(resets, every);
        const boundary = nextResetAt(from, schedule);

        const windows = resetWindowsOf(
          { messages: allowance(messages, { included: 10, resets, resetEvery: every }) },
          from,
        );

        if (resets === "never") return boundary === null && windows.messages === undefined;

        if (boundary === null) return false;

        if (DateTime.toEpochMillis(boundary) <= DateTime.toEpochMillis(from)) return false;

        const interval = everyIntervalOf(schedule)!;

        if (!same(boundary, DateTime.add(from, interval))) return false;

        // A multiplier can only move the boundary later, never earlier.
        const single = nextResetAt(from, scheduleOf(resets, 1))!;

        if (DateTime.toEpochMillis(boundary) < DateTime.toEpochMillis(single)) return false;

        const tied = periodTiedReset(schedule);

        if (tied !== ((resets === "month" || resets === "annual") && every === 1)) return false;

        if (tied !== (windows.messages === undefined)) return false;

        return windows.messages === undefined || same(windows.messages, boundary);
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * A carry is a rolling cap: what survives is the unspent part of the last
   * window, at most `carryCap` (or `included`), added to the grant. A quantity,
   * a `resets: "never"` allowance and an independently scheduled window are
   * kept by a period close rather than reset by it.
   */
  it.effect("a rollover carries at most its cap, and a close keeps what it does not own", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          remaining: Schema.Union([
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 200 }))),
            Schema.Literal("fallback"),
          ]),
          carryOver: Schema.Boolean,
          carryCap: Schema.optionalKey(
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          ),
          resets: AllResets,
          every: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
        }),
      ),
      ({ included, remaining, carryOver, carryCap, resets, every }) => {
        const built = allowance(messages, {
          included,
          resets,
          ...(every === 1 ? {} : { resetEvery: every }),
          ...(carryOver ? { carryOver: true } : {}),
          ...(carryOver && carryCap !== undefined ? { carryCap } : {}),
        });

        const state = stateAt(built, remaining === "fallback" ? undefined : remaining);
        const current = remaining === "fallback" ? included : remaining;
        const reset = resetOf(state, "messages", built);
        const own = resetOfFeature(state, "messages", built);
        const cap = carryCapOf(built);

        const ownCarried =
          built.carryOver === true ? Math.min(Math.max(current, 0), cap ?? included) : 0;

        if (includedRemainingOf(built) !== included) return false;
        // A quantity is never a counter, so it survives a close; the same is
        // true of `never` and of a window the period does not own.
        const kept = built.resets === "never" || !periodTiedReset(built);

        if (kept) {
          if (reset.kept !== true || reset.carried !== 0) return false;

          if (reset.remaining !== current) return false;

          return own.carried === ownCarried && own.remaining === included + ownCarried;
        }

        if (reset.kept !== false) return false;

        if (reset.carried !== ownCarried) return false;

        if (reset.remaining !== included + ownCarried) return false;

        if (reset.remaining > included + (cap ?? included)) return false;

        return reset.carried === own.carried && reset.remaining === own.remaining;
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * `ResetAllowance` closes exactly the window the standing recorded: before it,
   * or for a boundary a later tier change replaced, it records nothing. At the
   * boundary it clears the use and the money, returns any open hold to the
   * feature, and moves the boundary to the next interval.
   */
  it.effect("a reset fires only at its recorded boundary and moves the boundary on", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: WindowStock,
          usage: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
          held: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
          lateDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        }),
      ),
      ({ tier: stock, usage, held, lateDays }) => {
        const opened = subscribedIn(schedules, stock);
        const allowance = opened.allowances.messages!;
        const boundary = opened.resetAt?.messages;

        if (boundary === undefined) return false;

        const tracked =
          usage === 0
            ? []
            : decideAt(
                opened,
                new TrackUsage({ feature: "messages", amount: usage }),
                start,
                "use",
              );

        if (!isAccepted(tracked)) return false;
        const afterUsage = evolveAt(opened, tracked, start, "use");

        if (afterUsage._tag !== "Subscribed") return false;

        const heldDecision =
          held === 0
            ? []
            : decideAt(
                afterUsage,
                new Hold({
                  holdId: "hold-reset",
                  feature: "messages",
                  amount: Math.min(held, afterUsage.remaining.messages ?? 0),
                  expiresAt: DateTime.add(start, { days: 365 }),
                }),
                start,
                "hold",
              );

        if (!isAccepted(heldDecision)) return false;
        const state = evolveAt(afterUsage, heldDecision, start, "hold");

        if (state._tag !== "Subscribed") return false;

        // Not due yet: the boundary is in the future.
        const early = decideAt(
          state,
          new ResetAllowance({ feature: "messages", at: boundary }),
          start,
          "early",
        );

        if (!isAccepted(early) || early.length !== 0) return false;

        // The boundary after this one is not this window's boundary.
        const next = nextResetAt(boundary, allowance)!;

        const stale = decideAt(
          state,
          new ResetAllowance({ feature: "messages", at: next }),
          boundary,
          "stale",
        );

        if (!isAccepted(stale) || stale.length !== 0) return false;

        const at = DateTime.add(boundary, { days: lateDays });

        const due = decideAt(
          state,
          new ResetAllowance({ feature: "messages", at: boundary }),
          at,
          "due",
        );

        if (!isAccepted(due) || due.length === 0) return false;

        const reset = due.find(
          (event): event is InstanceType<typeof AllowanceReset> => event._tag === "AllowanceReset",
        );

        if (reset === undefined) return false;

        const expected = resetOfFeature(state, "messages", allowance);
        let carried = 0;

        if (allowance.carryOver === true) {
          const cap = carryCapOf(allowance) ?? 10;
          carried = Math.min(Math.max(state.remaining.messages ?? 0, 0), cap);
        }

        if (reset.feature !== "messages") return false;

        if (reset.carried !== carried) return false;

        if (reset.remaining !== 10 + carried) return false;

        if (!same(reset.remaining, expected.remaining)) return false;

        // A late fire starts the next window where it actually fired.
        if (!same(reset.resetAt, nextResetAt(at, allowance))) return false;

        const released = due.filter((event) => event._tag === "UsageReleased");

        const openHolds = Object.values(state.holds).filter(
          (entry) => entry.status === "open" && entry.feature === "messages",
        ).length;

        if (released.length !== openHolds) return false;

        if (released.length === 1 && (released[0] as { reason?: string }).reason !== "reset") {
          return false;
        }

        const after = evolveAt(state, due, at, "due");

        if (after._tag !== "Subscribed") return false;

        if (after.usage.messages !== 0) return false;

        if (after.remaining.messages !== reset.remaining) return false;

        if (!same(after.resetAt?.messages, reset.resetAt)) return false;

        // The same command is a replay: this window has already closed.
        const again = decideAt(
          after,
          new ResetAllowance({ feature: "messages", at: boundary }),
          at,
          "again",
        );

        return isAccepted(again) && again.length === 0;
      },
      { runs: 100, size: 30 },
    ),
  );

  /**
   * A period close is the boundary of a monthly allowance and nothing else: it
   * resets use for the feature, but leaves a daily or quarterly window — and
   * the quantity kind — exactly where it was, and adds the carry to a rollover.
   */
  it.effect("a period close resets the allowances it owns and keeps the rest", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: Stock,
          usage: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        }),
      ),
      ({ tier: stock, usage }) => {
        const opened = subscribedIn(schedules, stock);
        const allowance = opened.allowances.messages!;

        const tracked =
          usage === 0
            ? []
            : decideAt(
                opened,
                new TrackUsage({ feature: "messages", amount: usage }),
                start,
                "use",
              );

        if (!isAccepted(tracked)) return false;
        const state = evolveAt(opened, tracked, start, "use");

        if (state._tag !== "Subscribed") return false;
        const before = state.remaining.messages!;
        const boundary = state.period.end;
        const close = decideAt(state, new ClosePeriod({ periodEnd: boundary }), boundary, "close");

        if (!isAccepted(close)) return false;
        const after = evolveAt(state, close, boundary, "close");

        if (after._tag !== "Subscribed") return false;

        const tied = periodTiedReset(allowance);

        if (after.usage.messages !== undefined && tied && after.usage.messages !== 0) return false;

        if (!tied) {
          if (recordedAmount(tracked) !== 0 && after.usage.messages !== recordedAmount(tracked)) {
            return false;
          }

          if (after.remaining.messages !== before) return false;

          return same(after.resetAt?.messages, state.resetAt?.messages);
        }

        const cap = carryCapOf(allowance);
        const carried = allowance.carryOver === true ? Math.min(Math.max(before, 0), cap ?? 10) : 0;

        return after.remaining.messages === 10 + carried;
      },
      { runs: 100, size: 30 },
    ),
  );

  it("a quantity is never reset by a window or a close", () => {
    const built = allowance(seats, { included: 5, overage: "block", cap: 20 });
    const state = stateAt(built, 8);
    const reset = resetOf(state, "messages", built);
    expect(reset).toEqual({ remaining: 8, carried: 0, kept: true });
    expect(resetOfFeature(state, "messages", built)).toEqual({ remaining: 5, carried: 0 });
  });

  it("a daily allowance records its boundary at activation", () => {
    const state = subscribedIn(schedules, "daily");
    expect(state.resetAt?.messages).toEqual(DateTime.add(start, { days: 1 }));
    expect(periodTiedReset(state.allowances.messages!)).toBe(false);
  });

  it("an hourly multiplier is the window it says it is", () => {
    const state = subscribedIn(schedules, "four-hourly");
    expect(state.resetAt?.messages).toEqual(DateTime.add(start, { hours: 4 }));
  });
});
