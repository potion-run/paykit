import * as Schema from "effect/Schema";
import { allowancesOf, type Catalog } from "./Catalog.ts";
import type { BillingStateView } from "./Subscription/BillingState.view.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";

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
  "EnterGrace",
  "RecordPayment",
  "RecordPaymentFailure",
  "Recover",
  "Expire",
  "ScheduleCancellation",
  "Resume",
]);
export type AdminAction = typeof AdminAction.Type;

/** One action the console may offer, and the tiers a `ChangeTier` may choose. */
export interface AdminActionDescriptor {
  readonly action: AdminAction;
  /** Tier ids a `ChangeTier` may choose. Empty for every other action. */
  readonly tiers: ReadonlyArray<string>;
}

const actionOrder: ReadonlyArray<AdminAction> = [
  "GrantCredits",
  "ExtendTrial",
  "ChangeTier",
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
      // Mirror `ChangeTier`'s `DowngradeBelowUsage`, so the offered list can
      // never include a move the model refuses. Only a `block` allowance can
      // be oversubscribed: passing `included` is the ordinary state of a
      // billed or allowed one. Units an open hold reserves are owed exactly
      // like used ones, so they count against the target's included amount.
      return Object.values(allowances).every((allowance) => {
        if (allowance.overage !== "block" || allowance.included === "unlimited") return true;
        const feature = entitlements.features[allowance.feature];
        const used = feature?.used ?? 0;
        const reserved = feature?.reserved ?? 0;
        return used + reserved <= allowance.included;
      });
    })
    .map((tier) => tier.id);
};

/**
 * The actions that make sense for a standing, in a stable display order.
 *
 * `ChangeTier` is offered only when the catalog has a tier the account is not
 * on, the currency matches, and (when entitlements are supplied) the account's
 * used and reserved units fit the new tier's blocking allowances — the same
 * rule `ChangeTier`'s `DowngradeBelowUsage` applies. The model still decides:
 * this function never replaces a rejection or a preview.
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
  state: Pick<BillingStateView, "status" | "tier" | "currency" | "cancelAtPeriodEnd">,
  options: {
    readonly catalog?: Catalog;
    readonly entitlements?: EntitlementsState;
  } = {},
): ReadonlyArray<AdminActionDescriptor> => {
  if (state.status === "expired" || state.status === "canceled") return [];

  const tiers = changeTiers(state, options.catalog, options.entitlements);
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

  return actionOrder.flatMap((action) =>
    isOffered(action)
      ? [{ action, tiers: action === "ChangeTier" ? tiers : [] } satisfies AdminActionDescriptor]
      : [],
  );
};
