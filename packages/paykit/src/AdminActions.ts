import * as Schema from "effect/Schema";
import { allowancesOf, type Catalog } from "./Catalog.ts";
import type { BillingStateView } from "./Subscription/BillingState.view.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { spendCeilingOf } from "./Subscription/Subscription.state.ts";

/**
 * The commands a console may offer for one account. This is a UI aid, not an
 * authorization boundary: every action still goes through the command's own
 * middleware and `decide`, so an action this list omits is still refused by
 * the model if a caller sends it directly.
 */
export const AdminAction = Schema.Literals([
  "GrantCredits",
  "ExtendTrial",
  "ChangeTier",
  "ScheduleTierChange",
  "WithdrawTierChange",
  "EnterGrace",
  "RecordPayment",
  "RecordPaymentFailure",
  "Recover",
  "Expire",
  "ScheduleCancellation",
  "Resume",
]);
export type AdminAction = typeof AdminAction.Type;

/** One action the console may offer, and the tiers a tier change may choose. */
export interface AdminActionDescriptor {
  readonly action: AdminAction;
  /**
   * Tier ids a `ChangeTier` or `ScheduleTierChange` may choose. Empty for every
   * other action.
   */
  readonly tiers: ReadonlyArray<string>;
}

const actionOrder: ReadonlyArray<AdminAction> = [
  "GrantCredits",
  "ExtendTrial",
  "ChangeTier",
  "ScheduleTierChange",
  "WithdrawTierChange",
  "EnterGrace",
  "RecordPayment",
  "RecordPaymentFailure",
  "Recover",
  "Expire",
  "ScheduleCancellation",
  "Resume",
];

const changeTiers = (
  state: Pick<BillingStateView, "tier" | "currency">,
  catalog: Catalog | undefined,
  entitlements: EntitlementsState | undefined,
): ReadonlyArray<string> => {
  if (catalog === undefined) return [];
  return catalog.tiers
    .filter((tier) => tier.id !== state.tier)
    .filter(
      (tier) =>
        state.currency === undefined ||
        tier.price === undefined ||
        tier.price.currency === state.currency,
    )
    .filter((tier) => {
      if (entitlements === undefined) return true;
      const allowances = allowancesOf(catalog, tier.id);
      if (allowances === null) return false;
      // Mirror every ceiling `ChangeTier` refuses, so the offered list can never
      // include a move the model refuses. Units an open hold reserves are owed
      // exactly like used ones, so they count against each ceiling.
      //
      // `DowngradeBelowUsage`: a blocking count the usage is already past.
      // Passing `included` is the ordinary state of a billed or allowed one, so
      // only `block` qualifies.
      //
      // `DowngradeBelowSpend` and `DowngradeBelowCeiling`: a money or unit
      // ceiling the period already passed. A ceiling is kept across a change,
      // so moving under one would leave a standing every later `TrackUsage` and
      // `Hold` refuses until the period resets.
      return Object.values(allowances).every((allowance) => {
        const feature = entitlements.features[allowance.feature];
        const used = feature?.used ?? 0;
        const reserved = feature?.reserved ?? 0;
        if (
          allowance.overage === "block" &&
          allowance.included !== "unlimited" &&
          used + reserved > allowance.included
        ) {
          return false;
        }
        if (allowance.moneyCap !== undefined && (feature?.billed ?? 0) > allowance.moneyCap) {
          return false;
        }
        const ceiling = spendCeilingOf(allowance);
        return ceiling === null || used + reserved <= ceiling;
      });
    })
    .map((tier) => tier.id);
};

/**
 * The tiers a `ScheduleTierChange` may choose: every compatible tier but the
 * one the account is on. No entitlement filter applies, and that is the whole
 * point of scheduling — a smaller allowance than the period has already used is
 * refused now and belongs at the boundary, where the counters reset with it.
 */
const scheduleTiers = (
  state: Pick<BillingStateView, "tier" | "currency">,
  catalog: Catalog | undefined,
): ReadonlyArray<string> => {
  if (catalog === undefined) return [];
  return catalog.tiers
    .filter((tier) => tier.id !== state.tier)
    .filter(
      (tier) =>
        state.currency === undefined ||
        tier.price === undefined ||
        tier.price.currency === state.currency,
    )
    .map((tier) => tier.id);
};

/**
 * The actions that make sense for a standing, in a stable display order.
 *
 * `ChangeTier` is offered only when the catalog has a tier the account is not
 * on, the currency matches, and (when entitlements are supplied) the account's
 * used and reserved units fit the new tier's blocking allowances, unit ceiling
 * and money ceiling — the rules `ChangeTier`'s `DowngradeBelowUsage`,
 * `DowngradeBelowCeiling` and `DowngradeBelowSpend` apply. `ScheduleTierChange`
 * is offered for every other compatible tier, because a move those rules refuse
 * now is exactly what belongs at the boundary. `WithdrawTierChange` is offered
 * only while a change is scheduled. The model still decides: this function
 * never replaces a rejection or a preview.
 *
 * ### Offering actions from a billing snapshot
 * **Example:** What an operator may do with an account in grace
 * ```typescript
 * const actions = actionsFor(
 *   { status: "grace", tier: "pro", currency: "usd", cancelAtPeriodEnd: false },
 *   { catalog, entitlements },
 * );
 * // GrantCredits, ChangeTier, RecordPayment, RecordPaymentFailure, Recover, Expire
 * ```
 *
 * @primitive
 */
export const actionsFor = (
  state: Pick<
    BillingStateView,
    "status" | "tier" | "currency" | "cancelAtPeriodEnd" | "pendingTier"
  >,
  options: {
    readonly catalog?: Catalog;
    readonly entitlements?: EntitlementsState;
  } = {},
): ReadonlyArray<AdminActionDescriptor> => {
  if (state.status === "expired" || state.status === "canceled") return [];

  const tiers = changeTiers(state, options.catalog, options.entitlements);
  const scheduled = scheduleTiers(state, options.catalog);
  const isTrialing = state.status === "trialing";
  const isActive = state.status === "active";
  const isGrace = state.status === "grace";

  const isOffered = (action: AdminAction): boolean => {
    switch (action) {
      case "GrantCredits":
        return true;
      case "ExtendTrial":
        return isTrialing;
      case "ChangeTier":
        return tiers.length > 0;
      case "ScheduleTierChange":
        return scheduled.length > 0;
      case "WithdrawTierChange":
        return state.pendingTier !== undefined;
      case "EnterGrace":
        return isTrialing || isActive;
      case "RecordPayment":
        return isGrace;
      case "RecordPaymentFailure":
        return isTrialing || isActive || isGrace;
      case "Recover":
      case "Expire":
        return isGrace;
      case "ScheduleCancellation":
        return !state.cancelAtPeriodEnd;
      case "Resume":
        return state.cancelAtPeriodEnd;
    }
  };

  const tiersFor = (action: AdminAction): ReadonlyArray<string> => {
    if (action === "ChangeTier") return tiers;
    return action === "ScheduleTierChange" ? scheduled : [];
  };

  return actionOrder.flatMap((action) =>
    isOffered(action) ? [{ action, tiers: tiersFor(action) } satisfies AdminActionDescriptor] : [],
  );
};
