import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { creditRatesOf, tierTermsOf } from "../../src/Catalog.ts";
import { ConsumeCredits } from "../../src/Subscription/ConsumeCredits.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { PurchaseCredits } from "../../src/Subscription/PurchaseCredits.command.ts";
import {
  creditRateOf,
  initialSubscriptionState,
  prepaidCreditsOf,
  reservedCreditsOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  commandOf,
  Days,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  subscribedAt,
  testCatalog,
  TierName,
} from "./Arbitraries.ts";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const Step = Schema.Union([
  Schema.TaggedStruct("TrackCredits", {
    amount: Amount,
    dimension: Schema.Literals(["default", "gpt-large"]),
  }),
  Schema.TaggedStruct("Grant", { amount: Amount }),
  Schema.TaggedStruct("Purchase", { amount: Amount }),
  Schema.TaggedStruct("Consume", { amount: Amount }),
  Schema.TaggedStruct("ChangeTier", { tier: TierName }),
  Schema.TaggedStruct("ClosePeriod", {}),
]);
type Step = typeof Step.Type;

const CreditScript = Schema.Struct({
  startTier: TierName,
  steps: Schema.Array(
    Schema.Struct({
      step: Step,
      advanceDays: Days,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(60))),
});

const rateFor = (state: SubscribedState, dimension: "default" | "gpt-large"): number =>
  creditRateOf(state.rates["ai"]!, dimension);

describe("credits", () => {
  it.effect("the pool is a fold, never goes negative, and a change does not re-grant", () =>
    assertProperty(
      Arbitrary.schema(CreditScript),
      (script) => {
        let state = subscribedAt(script.startTier);
        let now = start;

        for (const [index, { step, advanceDays }] of script.steps.entries()) {
          now = DateTime.add(now, { days: advanceDays });
          const before = state;
          const command =
            step._tag === "TrackCredits"
              ? commandOf(
                  {
                    _tag: "TrackCredits",
                    amount: step.amount,
                    dimension: step.dimension,
                  },
                  state,
                  now,
                )
              : step._tag === "Grant"
                ? commandOf({ _tag: "GrantCredits", amount: step.amount }, state, now)
                : step._tag === "Purchase"
                  ? commandOf({ _tag: "PurchaseCredits", amount: step.amount }, state, now)
                  : step._tag === "Consume"
                    ? commandOf({ _tag: "ConsumeCredits", amount: step.amount }, state, now)
                    : step._tag === "ChangeTier"
                      ? commandOf({ _tag: "ChangeTier", tier: step.tier }, state, now)
                      : commandOf({ _tag: "ClosePeriod" }, state, now);
          const decision = decideAt(state, command, now, `step-${index}`);

          if (!isAccepted(decision)) {
            if (step._tag === "ClosePeriod") {
              // A period that is not due yet refuses explicitly.
              if (decision._tag !== "PeriodNotClosed") return false;
              continue;
            }
            if (step._tag === "TrackCredits") {
              if (decision._tag !== "CreditExceeded") return false;
              const cost = step.amount * rateFor(before, step.dimension);
              const rejection = decision as unknown as {
                readonly cost: number;
                readonly balance: number;
              };
              if (rejection.cost !== cost || rejection.balance !== before.credits) return false;
            } else if (step._tag === "Consume") {
              if (decision._tag !== "CreditExceedsBalance") return false;
              const rejection = decision as unknown as {
                readonly balance: number;
                readonly requested: number;
              };
              if (rejection.balance !== before.credits) return false;
              if (rejection.requested !== step.amount) return false;
            } else {
              return false;
            }
            continue;
          }

          // No generated credit command is a no-op.
          if (decision.length === 0) return false;

          const evolved = evolveAt(state, decision, now, `step-${index}`);
          if (evolved._tag !== "Subscribed") return false;
          const after = evolved;

          switch (step._tag) {
            case "TrackCredits": {
              const cost = step.amount * rateFor(before, step.dimension);
              const event = decision[0] as unknown as {
                readonly cost: number;
                readonly creditsAfter: number;
                readonly usedAfter: number;
                readonly remainingAfter: number | null;
              };
              if (event.cost !== cost) return false;
              if (event.creditsAfter !== before.credits - cost) return false;
              if (event.usedAfter !== (before.usage.ai ?? 0) + cost) return false;
              if (event.remainingAfter !== event.creditsAfter) return false;
              if (after.credits !== event.creditsAfter) return false;
              if ((after.usage.ai ?? 0) !== event.usedAfter) return false;
              if ((after.remaining.ai ?? null) !== event.creditsAfter) return false;
              // Expiring credits are spent first; a purchased pack is protected.
              if (
                prepaidCreditsOf(after) !==
                Math.max(0, Math.min(prepaidCreditsOf(before), event.creditsAfter))
              ) {
                return false;
              }
              break;
            }
            case "Grant": {
              const event = decision[0] as unknown as { readonly balanceAfter: number };
              if (event.balanceAfter !== before.credits + step.amount) return false;
              if (after.credits !== event.balanceAfter) return false;
              if (prepaidCreditsOf(after) !== prepaidCreditsOf(before)) return false;
              break;
            }
            case "Purchase": {
              const event = decision[0] as unknown as {
                readonly balanceAfter: number;
                readonly prepaidAfter: number;
              };
              if (event.balanceAfter !== before.credits + step.amount) return false;
              if (event.prepaidAfter !== prepaidCreditsOf(before) + step.amount) return false;
              if (after.credits !== event.balanceAfter) return false;
              if (prepaidCreditsOf(after) !== event.prepaidAfter) return false;
              break;
            }
            case "Consume": {
              const event = decision[0] as unknown as { readonly balanceAfter: number };
              if (event.balanceAfter !== before.credits - step.amount) return false;
              if (after.credits !== event.balanceAfter) return false;
              // Consuming spends the plan's credits before the pack.
              if (
                prepaidCreditsOf(after) !==
                Math.max(0, Math.min(prepaidCreditsOf(before), event.balanceAfter))
              ) {
                return false;
              }
              break;
            }
            case "ChangeTier": {
              const event = decision.find((entry) => entry._tag === "TierChanged") as
                | {
                    readonly credits: number;
                    readonly creditsExpire: string;
                    readonly rates: Readonly<Record<string, Readonly<Record<string, number>>>>;
                  }
                | undefined;
              if (event === undefined) return false;
              if (event.credits !== before.credits) return false;
              if (after.credits !== before.credits) return false;
              const terms = tierTermsOf(testCatalog, step.tier);
              if (terms === null) return false;
              if (event.creditsExpire !== terms.creditsExpire) return false;
              if (!same(event.rates, terms.rates)) return false;
              if (after.creditsExpire !== terms.creditsExpire) return false;
              if (!same(after.rates, terms.rates)) return false;
              // A tier change carries the balance and its protected part.
              if (prepaidCreditsOf(after) !== prepaidCreditsOf(before)) return false;
              break;
            }
            case "ClosePeriod": {
              const expired = decision.find((entry) => entry._tag === "CreditsExpired") as
                | { readonly amount: number }
                | undefined;
              if ((expired !== undefined) !== (before.creditsExpire === "period")) return false;
              const expiring =
                before.creditsExpire === "period" ? before.credits - prepaidCreditsOf(before) : 0;
              if (expired !== undefined && expired.amount !== expiring) return false;
              if (after.credits !== before.credits - expiring) return false;
              // A period close never touches what a pack bought.
              if (prepaidCreditsOf(after) !== prepaidCreditsOf(before)) return false;
              break;
            }
          }

          if (after.credits < 0) return false;
          state = after;
        }

        return true;
      },
      { runs: 80, size: 40 },
    ),
  );

  it.effect("a pack bought without a plan is spendable and never goes negative", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          seed: Amount,
          steps: Schema.Array(
            Schema.Struct({
              amount: Amount,
              dimension: Schema.Literals(["default", "gpt-large"]),
            }),
          ).pipe(Schema.check(Schema.isMaxLength(40))),
        }),
      ),
      ({ seed, steps }) => {
        const rates = creditRatesOf(testCatalog);
        const purchased = decideAt(
          initialSubscriptionState,
          new PurchaseCredits({ tier: "credits_1k", amount: seed, rates }),
          start,
          "buy",
        );
        if (!isAccepted(purchased)) return false;
        let state = evolveAt(initialSubscriptionState, purchased, start, "buy");
        if (state._tag !== "Unsubscribed") return false;
        if (state.credits !== seed || prepaidCreditsOf(state) !== seed) return false;

        for (const [index, step] of steps.entries()) {
          const cost = step.amount * creditRateOf(rates["ai"]!, step.dimension);
          const decision = decideAt(
            state,
            new TrackUsage({
              feature: "ai",
              amount: step.amount,
              dimension: step.dimension,
            }),
            start,
            `prepaid-${index}`,
          );

          if (!isAccepted(decision)) {
            if (decision._tag !== "CreditExceeded") return false;
            const rejection = decision as unknown as {
              readonly cost: number;
              readonly balance: number;
            };
            if (rejection.cost !== cost || rejection.balance !== (state.credits ?? 0)) {
              return false;
            }
            continue;
          }

          const event = decision[0] as unknown as {
            readonly cost: number;
            readonly creditsAfter: number;
            readonly usedAfter: number;
            readonly remainingAfter: number | null;
          };
          if (event.cost !== cost) return false;
          if (event.creditsAfter !== (state.credits ?? 0) - cost) return false;
          if (event.usedAfter !== (state.usage?.["ai"] ?? 0) + cost) return false;
          if (event.remainingAfter !== event.creditsAfter) return false;

          state = evolveAt(state, decision, start, `prepaid-${index}`);
          if (state._tag !== "Unsubscribed") return false;
          if ((state.credits ?? 0) < 0) return false;
          // Without a plan the whole pool is the pack, spent first and never
          // negative.
          if (prepaidCreditsOf(state) !== state.credits) return false;
        }

        return true;
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("a held pool cannot be spent twice", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          held: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
          spent: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
        }),
      ),
      ({ held, spent }) => {
        let state = subscribedAt("pro");
        // The hold takes its credits out of the spendable pool, not only out of
        // `credits`: a second spend must see the difference.
        const hold = decideAt(
          state,
          new Hold({
            holdId: "probe-hold",
            feature: "ai",
            amount: held,
            expiresAt: DateTime.add(start, { days: 1 }),
          }),
          start,
          "hold",
        );
        if (!isAccepted(hold)) return false;
        state = evolveAt(state, hold, start, "hold") as SubscribedState;

        const track = decideAt(
          state,
          new TrackUsage({ feature: "ai", amount: spent }),
          start,
          "track",
        );
        if (isAccepted(track)) {
          state = evolveAt(state, track, start, "track") as SubscribedState;
          // Every open hold is still covered, and the pool never went negative.
          if (state.credits < 0) return false;
          if (state.credits < reservedCreditsOf(state)) return false;
        }

        const consume = decideAt(state, new ConsumeCredits({ amount: spent }), start, "consume");
        if (isAccepted(consume)) {
          state = evolveAt(state, consume, start, "consume") as SubscribedState;
          if (state.credits < 0) return false;
          if (state.credits < reservedCreditsOf(state)) return false;
        }

        return true;
      },
      { runs: 80, size: 20 },
    ),
  );
});
