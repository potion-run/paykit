import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance, grant } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { evaluateCheck } from "../../src/Check.ts";
import { EntityId } from "../../src/Customer.ts";
import { feature, messages } from "../../src/Feature.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  remainingOf,
  reservedOf,
  scopeStateOf,
  usedOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { FeatureNotMetered, TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { Amount, decideAt, evolveAt, isAccepted, start, subscribedIn } from "./Arbitraries.ts";

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

const opened = (tierId: "capped" | "enterprise"): SubscribedState => subscribedIn(shapes, tierId);

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
      overage: "bill" as const,
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
            featureId: "messages",
            requiredBalance: step.amount,
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

describe("a scope's own cap", () => {
  it.effect("an entity's cap is its own, and check agrees scope by scope", () =>
    assertProperty(
      Arbitrary.schema(Schema.Array(Amount).pipe(Schema.check(Schema.isMaxLength(40)))),
      (amounts) => {
        const entity = EntityId.make("ent_shapes");
        let state = opened("capped");

        const attach = decideAt(
          state,
          new AttachEntity({ entityId: entity }),
          start,
          "entity-attach",
        );

        if (!isAccepted(attach)) return false;
        state = evolveAt(state, attach, start, "entity-attach") as SubscribedState;

        const terms = planTermsOf(shapes, "capped");

        if (terms === null) return false;

        const plan = decideAt(
          state,
          new ChangeTier({ tier: "capped", ...terms, entity }),
          start,
          "entity-plan",
        );

        if (!isAccepted(plan)) return false;
        state = evolveAt(state, plan, start, "entity-plan") as SubscribedState;

        for (const [index, amount] of amounts.entries()) {
          const before = scopeStateOf(state, entity);

          const decision = decideAt(
            state,
            new TrackUsage({ feature: "messages", amount, entity }),
            start,
            `entity-cap-${index}`,
          );

          const asked = evaluateCheck(capView(before), {
            account: "acct_entity_cap",
            featureId: "messages",
            requiredBalance: amount,
          });

          if (asked.allowed !== isAccepted(decision)) return false;

          if (!isAccepted(decision)) {
            // Only the ceiling may refuse a positive request on a scope that
            // owns this allowance.
            if (decision._tag !== "SpendCapExceeded") return false;
            continue;
          }

          state = evolveAt(state, decision, start, `entity-cap-${index}`) as SubscribedState;
          const after = scopeStateOf(state, entity);

          if (usedOf(after, "messages") + reservedOf(after, "messages") > CEILING) return false;
        }

        return true;
      },
      { runs: 80, size: 40 },
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
            { account: "acct_flag_property", featureId: "sso", requiredBalance: amount },
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
