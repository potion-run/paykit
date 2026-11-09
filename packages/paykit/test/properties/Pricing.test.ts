import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { planItemsOf, planOf } from "../../src/Catalog.ts";
import {
  initialSubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import {
  canonical,
  commandOf,
  Days,
  decideAt,
  evolveAt,
  foldAt,
  isAccepted,
  start,
  testCatalog,
  TierName,
} from "./Arbitraries.ts";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const Step = Schema.Union([
  Schema.TaggedStruct("ChangeTier", { tier: TierName }),
  Schema.TaggedStruct("PeriodEnded", {}),
]);

const PricingScript = Schema.Struct({
  startTier: TierName,
  steps: Schema.Array(
    Schema.Struct({
      step: Step,
      advanceDays: Days,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(60))),
});

const subscribed = (state: ReturnType<typeof evolveAt>): SubscribedState => {
  if (state._tag !== "Subscribed") throw new Error("the script never activated a standing");

  return state;
};

const priceOf = (tier: TierName) => planOf(testCatalog, tier)?.price;

describe("pricing", () => {
  it.effect("replaying the log reproduces the price the account was sold at", () =>
    assertProperty(
      Arbitrary.schema(PricingScript),
      (script) => {
        const opened = decideAt(
          initialSubscriptionState,
          commandOf({ _tag: "Subscribe", tier: script.startTier }, initialSubscriptionState, start),
          start,
          "subscribe",
        );

        if (!isAccepted(opened)) return false;

        let state = evolveAt(initialSubscriptionState, opened, start, "subscribe");
        let now = start;
        let expectedPrice = priceOf(script.startTier);
        const committed = [...opened];

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });

          const plan =
            step.step._tag === "ChangeTier"
              ? ({ _tag: "ChangeTier", tier: step.step.tier } as const)
              : ({ _tag: "PeriodEnded" } as const);

          const decision = decideAt(state, commandOf(plan, state, now), now, `step-${index}`);

          if (!isAccepted(decision)) {
            // A rejected move changes nothing; the log stays a prefix of the walk.
            if (!same(canonical(state), canonical(foldAt(committed, now)))) return false;
            continue;
          }

          const before = subscribed(state);

          if (plan._tag === "ChangeTier") {
            const changed = decision.find((event) => event._tag === "PlanChanged") as
              | {
                  readonly priceBefore?: { readonly amount: number };
                  readonly priceAfter?: { readonly amount: number };
                }
              | undefined;

            if (changed === undefined) return false;

            if (!same(changed.priceBefore, before.price)) return false;

            if (!same(changed.priceAfter, priceOf(plan.tier))) return false;
          } else {
            // A period boundary does not rewrite what the account pays.
            if (decision.some((event) => event._tag === "PlanChanged")) return false;
          }

          committed.push(...decision);
          state = evolveAt(state, decision, now, `step-${index}`);
          const after = subscribed(state);

          if (plan._tag === "ChangeTier") expectedPrice = priceOf(plan.tier);

          if (!same(after.price, expectedPrice)) return false;

          if (plan._tag === "PeriodEnded" && !same(after.price, before.price)) return false;
        }

        // The state and the log agree, prices included.
        if (!same(canonical(state), canonical(foldAt(committed, now)))) return false;

        return same(subscribed(state).price, expectedPrice);
      },
      { runs: 60, size: 40 },
    ),
  );

  it.effect("a free tier records no price and a priced tier clears it again", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          priced: Schema.Literals(["pro", "scale", "unlimited"]),
        }),
      ),
      ({ priced }) => {
        const free = planItemsOf(testCatalog, "free")!;

        const opened = decideAt(
          initialSubscriptionState,
          commandOf({ _tag: "Subscribe", tier: "free" }, initialSubscriptionState, start),
          start,
          "free",
        );

        if (!isAccepted(opened)) return false;
        let state = evolveAt(initialSubscriptionState, opened, start, "free");

        if (subscribed(state).price !== undefined) return false;

        const changed = decideAt(
          state,
          commandOf({ _tag: "ChangeTier", tier: priced }, state, start),
          start,
          "upgrade",
        );

        if (!isAccepted(changed)) return false;
        state = evolveAt(state, changed, start, "upgrade");

        if (!same(subscribed(state).price, planOf(testCatalog, priced)?.price)) return false;

        const downgraded = decideAt(
          state,
          commandOf({ _tag: "ChangeTier", tier: "free" }, state, start),
          start,
          "downgrade",
        );

        if (!isAccepted(downgraded)) return false;
        state = evolveAt(state, downgraded, start, "downgrade");

        if (subscribed(state).price !== undefined) return false;

        return same(subscribed(state).allowances, free);
      },
      { runs: 20 },
    ),
  );

  it("an activation records the price it was sold at", () => {
    const pro = planItemsOf(testCatalog, "pro")!;

    const decision = decideAt(
      initialSubscriptionState,
      commandOf({ _tag: "Subscribe", tier: "pro" }, initialSubscriptionState, start),
      start,
      "subscribe",
    );

    expect(isAccepted(decision)).toBe(true);

    if (!isAccepted(decision)) return;
    const activated = decision[0] as { readonly _tag: string; readonly price?: { amount: number } };
    expect(activated._tag).toBe("SubscriptionActivated");
    expect(activated.price?.amount).toBe(1_900);
    expect(pro.messages?.included).toBe(2_000);
  });
});
