import * as Schema from "effect/Schema";
import { allowancesOf, type Catalog } from "./Catalog.ts";
import { downgradeOf } from "./Subscription/Allowance.verdict.ts";
import type { BillingStateView } from "./Subscription/BillingState.view.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { standingPhaseTagOfStatus } from "./Subscription/StandingPhase.ts";
import { priceFor, type Tier } from "./Tier.ts";

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
  /**
   * Money back to the customer. Unlike every other action, it is not a command
   * on the standing: it takes money through the provider and records a refund,
   * so it stays available after a standing ends and is gated by what the
   * account was charged, not by its phase.
   */
  "Refund",
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

const actionOrder: ReadonlyArray<Exclude<AdminAction, "Refund">> = [
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

/**
 * The currencies this account can still be refunded in: charged minus already
 * refunded, per currency, with the same ceiling the binding checks. Only a
 * positive remainder is offered, so a button is never a guaranteed
 * `RefundExceedsCharged`.
 */
export const refundableCurrencies = (
  charged: BillingStateView["charged"],
  refunded: BillingStateView["refunded"],
): ReadonlyArray<string> =>
  Object.keys(charged ?? {})
    .filter((currency) => (charged?.[currency] ?? 0) - (refunded?.[currency] ?? 0) > 0)
    .sort();

/**
 * A pack is a purchase, not a tier: it grants credits, has no allowances, and
 * never becomes a standing. A tier-change command that names one is refused, so
 * the console must not offer it.
 */
const sellableTier = (tier: Tier): boolean => (tier.kind ?? "subscription") !== "one_off";

const changeTiers = (
  state: Pick<BillingStateView, "tier" | "currency">,
  catalog: Catalog | undefined,
  entitlements: EntitlementsState | undefined,
): ReadonlyArray<string> => {
  if (catalog === undefined) return [];
  return catalog.tiers
    .filter(sellableTier)
    .filter((tier) => tier.id !== state.tier)
    .filter(
      (tier) =>
        state.currency === undefined ||
        tier.price === undefined ||
        priceFor(tier.price, state.currency) !== null,
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
        return (
          downgradeOf(allowance, {
            used: feature?.used ?? 0,
            reserved: feature?.reserved ?? 0,
            billed: feature?.billed ?? 0,
          })._tag === "Allowed"
        );
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
    .filter(sellableTier)
    .filter((tier) => tier.id !== state.tier)
    .filter(
      (tier) =>
        state.currency === undefined ||
        tier.price === undefined ||
        priceFor(tier.price, state.currency) !== null,
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
 * only while a change is scheduled. `Refund` is offered whenever a currency
 * still has money to send back, even on a terminal standing: it is a money
 * operation, not a move on the standing. The model still decides: this function
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
    "status" | "tier" | "currency" | "cancelAtPeriodEnd" | "pendingTier" | "charged" | "refunded"
  >,
  options: {
    readonly catalog?: Catalog;
    readonly entitlements?: EntitlementsState;
  } = {},
): ReadonlyArray<AdminActionDescriptor> => {
  const phase = standingPhaseTagOfStatus(state.status);
  const refundable = refundableCurrencies(state.charged, state.refunded);
  const offerRefund: ReadonlyArray<AdminActionDescriptor> =
    refundable.length === 0 ? [] : [{ action: "Refund", tiers: [] }];

  if (phase === "Expired" || phase === "Canceled") return offerRefund;

  const tiers = changeTiers(state, options.catalog, options.entitlements);
  const scheduled = scheduleTiers(state, options.catalog);
  const isTrialing = phase === "Trialing";
  const isActive = phase === "Active";
  const isGrace = phase === "Grace";

  const isOffered = (action: Exclude<AdminAction, "Refund">): boolean => {
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

  const tiersFor = (action: Exclude<AdminAction, "Refund">): ReadonlyArray<string> => {
    if (action === "ChangeTier") return tiers;
    return action === "ScheduleTierChange" ? scheduled : [];
  };

  const standing = actionOrder.flatMap((action) =>
    isOffered(action) ? [{ action, tiers: tiersFor(action) }] : [],
  );
  return refundable.length === 0 ? standing : [...standing, ...offerRefund];
};
