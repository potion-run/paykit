import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance, grant } from "../../src/Allowance.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { evaluateCheck } from "../../src/Check.ts";
import { feature, messages } from "../../src/Feature.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import {
  initialSubscriptionState,
  remainingOf,
  reservedOf,
  usedOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { FeatureNotMetered, TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { Amount, decideAt, evolveAt, isAccepted, start } from "./Arbitraries.ts";

const sso = feature({ id: "sso", name: "SSO", kind: "flag" });

const shapes = Effect.runSync(
  catalog({
    features: [messages, sso],
    tiers: [
      tier({
        id: "capped",
        grants: [allowance(messages, { included: 100, overage: "bill", cap: 20 })],
      }),
      tier({
        id: "enterprise",
        grants: [allowance(messages, { included: 100 }), grant(sso)],
      }),
    ],
  }),
);

const opened = (tierId: "capped" | "enterprise"): SubscribedState => {
  const terms = tierTermsOf(shapes, tierId);
  if (terms === null) throw new Error(`the shape catalog is missing ${tierId}`);
  const decision = decideAt(
    initialSubscriptionState,
    new Subscribe({ tier: tierId, ...terms }),
    start,
    "open",
  );
  if (!isAccepted(decision)) throw new Error(`the shape catalog could not open ${tierId}`);
  const state = evolveAt(initialSubscriptionState, decision, start, "open");
  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");
  return state;
};

const CEILING = 120;

const CapStep = Schema.Union([
  Schema.TaggedStruct("Track", { amount: Amount }),
  Schema.TaggedStruct("Hold", { amount: Amount }),
]);
type CapStep = typeof CapStep.Type;

const capView = (state: SubscribedState) => ({
  standing: "good" as const,
  features: {
    messages: {
      overage: "bill",
      remaining: remainingOf(state, "messages"),
      resetsAt: null,
      cap: 20,
      carried: 0,
    },
  },
});

describe("spend cap", () => {
  it.effect("a cap is a ceiling on billed and held units, and check agrees", () =>
    assertProperty(
      Arbitrary.schema(Schema.Array(CapStep).pipe(Schema.check(Schema.isMaxLength(60)))),
      (steps) => {
        let state = opened("capped");
        for (const [index, step] of steps.entries()) {
          const used = usedOf(state, "messages");
          const reserved = reservedOf(state, "messages");
          const headroom = CEILING - used - reserved;
          const decision =
            step._tag === "Track"
              ? decideAt(
                  state,
                  new TrackUsage({ feature: "messages", amount: step.amount }),
                  start,
                  `cap-${index}`,
                )
              : decideAt(
                  state,
                  new Hold({
                    holdId: `cap-hold-${index}`,
                    feature: "messages",
                    amount: step.amount,
                    expiresAt: DateTime.add(start, { days: 1 }),
                  }),
                  start,
                  `cap-${index}`,
                );

          const asked = evaluateCheck(capView(state), {
            account: "acct_cap_property",
            feature: "messages",
            amount: step.amount,
          });
          if (asked.allowed !== isAccepted(decision)) return false;

          if (!isAccepted(decision)) {
            if (decision._tag !== "SpendCapExceeded") return false;
            if (step.amount <= headroom) return false;
            continue;
          }

          if (step.amount > headroom) return false;
          state = evolveAt(state, decision, start, `cap-${index}`) as SubscribedState;
          if (usedOf(state, "messages") + reservedOf(state, "messages") > CEILING) return false;
        }

        return usedOf(state, "messages") + reservedOf(state, "messages") <= CEILING;
      },
      { runs: 100, size: 40 },
    ),
  );
});

describe("flags", () => {
  it.effect("a flag is granted, never metered: no usage, no hold, still allowed", () =>
    assertProperty(
      Arbitrary.schema(Schema.Array(Amount).pipe(Schema.check(Schema.isMaxLength(40)))),
      (amounts) => {
        let state = opened("enterprise");
        for (const [index, amount] of amounts.entries()) {
          const track = decideAt(
            state,
            new TrackUsage({ feature: "sso", amount }),
            start,
            `flag-track-${index}`,
          );
          if (!Schema.is(FeatureNotMetered)(track)) return false;

          const hold = decideAt(
            state,
            new Hold({
              holdId: `flag-hold-${index}`,
              feature: "sso",
              amount,
              expiresAt: DateTime.add(start, { days: 1 }),
            }),
            start,
            `flag-hold-${index}`,
          );
          if (!Schema.is(FeatureNotMetered)(hold)) return false;

          const asked = evaluateCheck(
            {
              standing: "good",
              features: { sso: { overage: "allow", remaining: null, resetsAt: null } },
            },
            { account: "acct_flag_property", feature: "sso", amount },
          );
          if (!asked.allowed) return false;
          if (state.remaining.sso !== null) return false;
          if (usedOf(state, "sso") !== 0 || reservedOf(state, "sso") !== 0) return false;
        }
        return true;
      },
      { runs: 60, size: 20 },
    ),
  );
});
