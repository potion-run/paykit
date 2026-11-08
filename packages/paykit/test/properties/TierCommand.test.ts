import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { prorate } from "../../src/Proration.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  planChangeTier,
  purchaseCreditsInputOf,
  scheduleTierChangeInputOf,
  subscribeInputOf,
} from "../../src/TierCommand.ts";
import { assertProperty } from "../support/Property.ts";
import { start, subscribedAt, testCatalog, TierName } from "./Arbitraries.ts";

/**
 * Every tier a generated script may sell, plus the two the builders must refuse:
 * a one-off pack (bought, never subscribed or moved onto) and an id no catalog
 * has. The pack is declared here because the script catalog has no use for one.
 */
const pack = tier({
  id: "pack",
  kind: "one_off",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  credits: 10_000,
  grants: [],
});

const buildersCatalog = Effect.runSync(
  catalog({ features: testCatalog.features, tiers: [...testCatalog.tiers, pack] }),
);

const BuildTier = Schema.Union([TierName, Schema.Literal("pack"), Schema.Literal("missing")]);

type BuildTier = typeof BuildTier.Type;

const Case = Schema.Struct({
  tier: BuildTier,
  /** The tier the standing is on, or `none` for an account with no plan yet. */
  stateTier: Schema.Union([TierName, Schema.Literal("none")]),
  anchorTz: Schema.optionalKey(Schema.Literals(["UTC", "America/New_York"])),
  invoiceId: Schema.optionalKey(Schema.String),
  /** Days from the period start; past-the-end and outside instants are legal. */
  offsetDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 90 }))),
});

type Case = typeof Case.Type;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

describe("tier command builders", () => {
  /**
   * A builder is the one place a catalog term becomes a command. If it drops a
   * field, disagrees with the terms, or builds a payload for a shape the tier
   * cannot take, `CatalogGuard` is the only backstop — and a caller that never
   * goes through the guard would write a standing the deploy never sold. The
   * check is therefore against `tierTermsOf` and the guard itself, not against
   * a hand-written expectation.
   */
  it.effect("build the catalog's terms and pass the guard, or refuse the shape", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const terms = tierTermsOf(buildersCatalog, input.tier);
        const sellable = terms !== null && terms.kind !== "one_off";
        const packable = terms !== null && terms.kind === "one_off";

        const state =
          input.stateTier === "none" ? initialSubscriptionState : subscribedAt(input.stateTier);

        const at = DateTime.add(start, { days: input.offsetDays });

        const subscribe = subscribeInputOf(
          buildersCatalog,
          input.tier,
          input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz },
        );

        const schedule = scheduleTierChangeInputOf(buildersCatalog, input.tier);
        const plan = planChangeTier(buildersCatalog, input.tier, state, at);

        const purchase = purchaseCreditsInputOf(
          buildersCatalog,
          input.tier,
          input.invoiceId === undefined ? {} : { invoiceId: input.invoiceId },
        );

        if (!sellable) {
          if (subscribe !== null || schedule !== null || plan !== null) return false;
        } else {
          if (subscribe === null || schedule === null || plan === null) return false;

          if (subscribe.tier !== input.tier || schedule.tier !== input.tier) return false;

          if (plan.input.tier !== input.tier) return false;

          // Every grant field is the catalog's, not a caller's copy.
          if (!same(subscribe.allowances, terms.allowances)) return false;

          if (!same(schedule.allowances, terms.allowances)) return false;

          if (!same(plan.input.allowances, terms.allowances)) return false;

          if (subscribe.credits !== terms.credits || schedule.credits !== terms.credits) {
            return false;
          }

          if (plan.input.credits !== terms.credits) return false;

          if (subscribe.creditsExpire !== terms.creditsExpire) return false;

          if (schedule.creditsExpire !== terms.creditsExpire) return false;

          if (plan.input.creditsExpire !== terms.creditsExpire) return false;

          if (!same(subscribe.rates, terms.rates)) return false;

          if (!same(schedule.rates, terms.rates)) return false;

          if (!same(plan.input.rates, terms.rates)) return false;

          if (subscribe.topUp !== terms.topUp || schedule.topUp !== terms.topUp) return false;

          if (plan.input.topUp !== terms.topUp) return false;

          if (!same(subscribe.price, terms.price)) return false;

          if (!same(schedule.price, terms.price)) return false;

          if (!same(plan.input.price, terms.price)) return false;

          if (subscribe.anchorTz !== input.anchorTz) return false;

          if (catalogMismatchOf(buildersCatalog, subscribe) !== null) return false;

          if (catalogMismatchOf(buildersCatalog, schedule) !== null) return false;

          if (catalogMismatchOf(buildersCatalog, plan.input) !== null) return false;

          // The plan quotes exactly what the same prices and period charge, and
          // carries the quote only when there is one to carry.
          const quote =
            state._tag === "Subscribed"
              ? prorate({
                  from: state.price,
                  to: terms.price,
                  period: { start: state.period.start, end: state.period.end },
                  at,
                })
              : null;

          if (!same(plan.proration, quote)) return false;

          if ("proration" in plan.input !== (quote !== null)) return false;
        }

        if (!packable) {
          return purchase === null;
        }

        if (purchase === null) return false;

        if (purchase.tier !== input.tier) return false;

        if (purchase.amount !== terms.credits) return false;

        if (!same(purchase.rates, terms.rates)) return false;

        if (!same(purchase.price, terms.price)) return false;

        return purchase.invoiceId === input.invoiceId;
      },
      { runs: 200, size: 30 },
    ),
  );
});
