import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { evaluateCheck } from "../../src/Check.ts";
import { messages } from "../../src/Feature.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  billableLines,
  periodUsageCommandId,
} from "../../src/Subscription/PeriodCloseUsage.policy.ts";
import { ReleaseHold } from "../../src/Subscription/ReleaseHold.command.ts";
import { SettleHold } from "../../src/Subscription/SettleHold.command.ts";
import {
  billedOf,
  billableUnitsOf,
  chargeOf,
  remainingOf,
  reservedOf,
  usedOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedIn } from "./Arbitraries.ts";

const unitPrice = { amount: 2, currency: "usd" } as const;
const moneyCap = 400;
const included = 100;

const postpaidTier = tier({
  id: "paid",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included, overage: "bill", unitPrice, moneyCap })],
});

const postpaidCatalog = Effect.runSync(catalog({ features: [messages], tiers: [postpaidTier] }));
const account = "acct_postpaid";

const Step = Schema.Union([
  Schema.TaggedStruct("Track", {
    amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 300 }))),
  }),
  Schema.TaggedStruct("Hold", {
    holdId: Schema.Literals(["hold-a", "hold-b"]),
    amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 300 }))),
  }),
  Schema.TaggedStruct("Settle", {
    holdId: Schema.Literals(["hold-a", "hold-b"]),
    amount: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 300 }))),
    ),
  }),
  Schema.TaggedStruct("Release", { holdId: Schema.Literals(["hold-a", "hold-b"]) }),
]);

type Step = typeof Step.Type;

const Script = Schema.Struct({
  steps: Schema.Array(Step).pipe(Schema.check(Schema.isMaxLength(60))),
});

const commandFor = (step: Step) => {
  switch (step._tag) {
    case "Track":
      return new TrackUsage({ feature: "messages", amount: step.amount });
    case "Hold":
      return new Hold({
        holdId: step.holdId,
        feature: "messages",
        amount: step.amount,
        expiresAt: DateTime.add(start, { days: 365 }),
      });
    case "Settle":
      return new SettleHold({
        holdId: step.holdId,
        ...(step.amount === undefined ? {} : { amount: step.amount }),
      });
    case "Release":
      return new ReleaseHold({ holdId: step.holdId });
  }
};

const viewOf = (state: SubscribedState) => ({
  standing: "good" as const,
  features: {
    messages: {
      overage: "bill" as const,
      remaining: remainingOf(state, "messages"),
      resetsAt: null,
      carried: 0,
      pricing: { _tag: "unit" as const, unitPrice },
      moneyCap,
      billed: billedOf(state, "messages"),
      used: usedOf(state, "messages"),
      included,
      reserved: reservedOf(state, "messages"),
    },
  },
});

const expectedBilled = (used: number): number => Math.max(0, used - included) * unitPrice.amount;

describe("period billing", () => {
  it.effect("reports only the priced units past included, once per period", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          features: Schema.Array(
            Schema.Struct({
              used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
              included: Schema.Int.pipe(
                Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
              ),
              priced: Schema.Boolean,
            }),
          ).pipe(Schema.check(Schema.isMaxLength(4))),
          start: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000_000 })),
          ),
          end: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000_000_000 })),
          ),
        }),
      ),
      ({ features: specs, start: startMillis, end: endMillis }) => {
        // The view carries the split, not the raw counters: a price the period
        // recorded nothing at is not a line in the report.
        const features = Object.fromEntries(
          specs.map((spec, index) => [
            `f${index}`,
            {
              priced: spec.priced
                ? { "usd:2": { unitPrice, quantity: Math.max(0, spec.used - spec.included) } }
                : undefined,
            } as never,
          ]),
        );

        const lines = billableLines(features as never);

        const expected = specs.flatMap((spec, index) => {
          const quantity = spec.priced ? Math.max(0, spec.used - spec.included) : 0;

          return quantity === 0 ? [] : [{ feature: `f${index}`, unitPrice, quantity }];
        });

        if (JSON.stringify(lines) !== JSON.stringify(expected)) return false;

        const start = DateTime.makeUnsafe(startMillis);
        const end = DateTime.makeUnsafe(startMillis + endMillis);
        const key = periodUsageCommandId(start, end);

        if (key !== periodUsageCommandId(start, end)) return false;
        const other = periodUsageCommandId(start, DateTime.makeUnsafe(startMillis + endMillis + 1));

        return key !== other;
      },
      { runs: 80, size: 20 },
    ),
  );
});

describe("postpaid money", () => {
  it.effect("billable units start after included and add up over a split", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
          used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
          amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
          split: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
          price: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        }),
      ),
      ({ included, used, amount, split, price }) => {
        const total = billableUnitsOf(included, used, amount);

        if (total < 0 || total > amount) return false;

        if (used + amount <= included && total !== 0) return false;

        if (used >= included && total !== amount) return false;

        if (
          chargeOf(
            { _tag: "unit", unitPrice: { amount: price, currency: "usd" } },
            included,
            used,
            amount,
          ) !==
          total * price
        ) {
          return false;
        }

        // A usage event split in two bills the same units as one.
        const first = Math.min(split, amount);
        const second = amount - first;

        return (
          billableUnitsOf(included, used, amount) ===
          billableUnitsOf(included, used, first) + billableUnitsOf(included, used + first, second)
        );
      },
      { runs: 100, size: 30 },
    ),
  );

  it.effect("billed money is the billable part of used, never past the cap", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        let state: SubscribedState = subscribedIn(postpaidCatalog, "paid");

        for (const [index, step] of script.steps.entries()) {
          const before = state;
          const decision = decideAt(state, commandFor(step), start, `postpaid-${index}`);

          const asked = evaluateCheck(viewOf(before), {
            account,
            feature: "messages",
            amount: step._tag === "Track" || step._tag === "Hold" ? step.amount : 1,
          });

          // A hold id already issued is a replay that records nothing; the
          // read path cannot know that, so it is not an agreement case.
          const replayHold = step._tag === "Hold" && before.holds[step.holdId] !== undefined;

          if (
            (step._tag === "Track" || (step._tag === "Hold" && !replayHold)) &&
            asked.allowed !== isAccepted(decision)
          ) {
            return false;
          }

          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, start, `postpaid-${index}`) as SubscribedState;

          const used = usedOf(state, "messages");
          const billed = billedOf(state, "messages");

          if (billed > moneyCap) return false;

          // Each unit past `included` is billed once, whatever holds were open.
          if (billed !== expectedBilled(used)) return false;

          if (usedOf(before, "messages") > used && step._tag !== "Settle") return false;
        }

        return true;
      },
      { runs: 80, size: 40 },
    ),
  );
});
