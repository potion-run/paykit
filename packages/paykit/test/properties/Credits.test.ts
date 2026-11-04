import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { tierTermsOf } from "../../src/Catalog.ts";
import {
  initialSubscriptionState,
  creditRateOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  commandOf,
  Days,
  decideAt,
  evolveAt,
  isAccepted,
  start,
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

const opened = (tier: TierName): SubscribedState => {
  const decision = decideAt(
    initialSubscriptionState,
    commandOf({ _tag: "Subscribe", tier }, initialSubscriptionState, start),
    start,
    "open",
  );
  if (!isAccepted(decision)) throw new Error("the fixture catalog could not open a standing");
  const state = evolveAt(initialSubscriptionState, decision, start, "open");
  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");
  return state;
};

const rateFor = (state: SubscribedState, dimension: "default" | "gpt-large"): number =>
  creditRateOf(state.rates["ai"]!, dimension);

describe("credits", () => {
  it.effect("the pool is a fold, never goes negative, and a change does not re-grant", () =>
    assertProperty(
      Arbitrary.schema(CreditScript),
      (script) => {
        let state = opened(script.startTier);
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
              break;
            }
            case "Grant": {
              const event = decision[0] as unknown as { readonly balanceAfter: number };
              if (event.balanceAfter !== before.credits + step.amount) return false;
              if (after.credits !== event.balanceAfter) return false;
              break;
            }
            case "Consume": {
              const event = decision[0] as unknown as { readonly balanceAfter: number };
              if (event.balanceAfter !== before.credits - step.amount) return false;
              if (after.credits !== event.balanceAfter) return false;
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
              break;
            }
            case "ClosePeriod": {
              const expired = decision.some((entry) => entry._tag === "CreditsExpired");
              if (expired !== (before.creditsExpire === "period")) return false;
              const expected = before.creditsExpire === "period" ? 0 : before.credits;
              if (after.credits !== expected) return false;
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
});
