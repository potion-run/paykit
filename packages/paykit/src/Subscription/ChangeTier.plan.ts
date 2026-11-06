import type * as DateTime from "effect/DateTime";
import { type Catalog, tierOf, tierTermsOf } from "../Catalog.ts";
import { prorate, type Proration } from "../Proration.ts";
import { ChangeTier } from "./ChangeTier.command.ts";
import type { SubscriptionState } from "./Subscription.state.ts";

/** The command a tier change implies, and the proration it carries. */
export interface ChangeTierPlan {
  readonly command: ChangeTier;
  readonly proration: Proration | null;
}

/**
 * Build a `ChangeTier` from the catalog and the account's current state.
 *
 * `Preview` and the admin apply path both call this, so a catalog field cannot
 * be added to one and forgotten in the other. The function is pure: `at` is
 * the same clock value the caller passes to `Subscription.predict` or to the
 * command that will decide it.
 */
export const planChangeTier = (
  catalog: Catalog,
  tierId: string,
  state: SubscriptionState,
  at: DateTime.Utc,
): ChangeTierPlan | null => {
  const tier = tierOf(catalog, tierId);
  const terms = tierTermsOf(catalog, tierId);
  if (tier === null || terms === null || terms.kind === "one_off") return null;
  const proration =
    state._tag === "Subscribed"
      ? prorate({
          from: state.price,
          to: tier.price,
          period: { start: state.period.start, end: state.period.end },
          at,
        })
      : null;
  return {
    command: new ChangeTier({
      tier: tier.id,
      allowances: terms.allowances,
      credits: terms.credits,
      creditsExpire: terms.creditsExpire,
      ...(terms.topUp === undefined ? {} : { topUp: terms.topUp }),
      rates: terms.rates,
      ...(terms.price === undefined ? {} : { price: terms.price }),
      ...(proration === null ? {} : { proration }),
    }),
    proration,
  };
};
