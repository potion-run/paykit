import type * as DateTime from "effect/DateTime";
import type { Allowance, Allowances } from "./Allowance.ts";
import { type Catalog, planTermsOf, type PlanTerms } from "./Catalog.ts";
import { catalogMismatchOf } from "./CatalogGuard.ts";
import { CatalogMismatch } from "./CatalogMismatch.rejection.ts";
import type { CreditRateCards } from "./Feature.ts";
import { prorate, type Proration } from "./Proration.ts";
import type { SubscriptionState } from "./Subscription/Subscription.state.ts";
import { currencyOf, priceOf } from "./Subscription/Subscription.state.ts";
import type { CreditsExpire, Price, TopUpTerms } from "./Tier.ts";

/**
 * One join from a tier id to the input a command carries.
 *
 * A command cannot read the catalog — `decide` is pure, so the terms a tier was
 * sold at travel on the command and into the event. Every path that sells,
 * schedules, previews or buys a tier therefore has to copy the same fields, and
 * a caller that copies them by hand can leave one out; `CatalogGuard` is the
 * backstop that refuses the result. These builders are the one place the copy
 * happens: each returns the plain input, or `null` when the catalog does not
 * sell the tier, and the caller wraps it in the command class it belongs to.
 *
 * The tier's `kind` matters here: a one-off tier is a pack of credits, so it can
 * be bought but not subscribed to or moved onto. {@link planChangeTier} refuses
 * it; {@link purchaseCreditsInputOf} is the only builder that accepts one.
 *
 * @primitive
 */

/**
 * The catalog-derived fields a `Subscribe`, `StartTrial`, `ChangeTier` or
 * `ScheduleTierChange` carries. The optional fields are omitted rather than set
 * to `undefined`, so a command for an ordinary plan does not grow empty keys.
 */
export interface TierGrantInput {
  readonly tier: string;
  readonly allowances: Allowances;
  readonly credits: number;
  readonly creditsExpire: CreditsExpire;
  readonly topUp?: TopUpTerms;
  readonly rates: CreditRateCards;
  readonly price?: Price;
}

/** What a plan's terms become once a caller has stated, or not stated, the items it holds. */
export interface GrantedPlanInput<A> {
  /** The command input, with the bespoke allowances when the caller stated any. */
  readonly input: A;
  /** The guard's answer, or `null` when the input may be sent. */
  readonly mismatch: CatalogMismatch | null;
}

/**
 * A plan's catalog terms with the plan items a caller states for a custom plan.
 *
 * The array is folded into the record a command carries, and the result is
 * judged by the same pure guard a wire caller meets — so an in-process sender
 * and an HTTP caller cannot disagree about what a plan may grant. Omitting
 * `grants` keeps the catalog's defaults, which is the ordinary case; stating
 * them for a fixed plan is refused by the guard's exact-match rule, not by a
 * second check here (ADR 0041 §6).
 *
 * ### Attaching a bespoke deal
 * **Example:** A plan with negotiated items
 * ```typescript
 * const plan = planChangeTier(catalog, "enterprise", state, now);
 * if (plan !== null) {
 *   const granted = withGrants(catalog, plan.input, request.grants);
 *   if (granted.mismatch !== null) return yield* granted.mismatch;
 *   yield* subscription.send(ref, new ChangeTier(granted.input), { commandId });
 * }
 * ```
 *
 * @primitive
 */
export const withGrants = <A extends TierGrantInput>(
  catalog: Catalog,
  terms: A,
  grants: ReadonlyArray<Allowance> | undefined,
): GrantedPlanInput<A> => {
  if (grants === undefined) return { input: terms, mismatch: null };

  const allowances: Record<string, Allowance> = {};

  for (const grant of grants) {
    // A repeated feature would silently collapse to whichever item came last,
    // and the two items may disagree about the ceiling or the price.
    if (allowances[grant.feature] !== undefined) {
      return {
        input: terms,
        mismatch: new CatalogMismatch({
          tier: terms.tier,
          feature: grant.feature,
          field: "allowances",
          expected: "one plan item per feature",
          actual: "duplicate",
        }),
      };
    }

    allowances[grant.feature] = grant;
  }

  const input = { ...terms, allowances };

  return { input, mismatch: catalogMismatchOf(catalog, input) };
};

/** The catalog fields every tier command shares, in one shape. */
const grantOf = (tierId: string, terms: PlanTerms): TierGrantInput => ({
  tier: tierId,
  allowances: terms.allowances,
  credits: terms.credits,
  creditsExpire: terms.creditsExpire,
  ...(terms.topUp === undefined ? {} : { topUp: terms.topUp }),
  rates: terms.rates,
  ...(terms.price === undefined ? {} : { price: terms.price }),
});

/**
 * The input a `Subscribe` carries for a tier, or `null` when the catalog does
 * not sell it. A one-off pack is also refused: a pack is bought through
 * `PurchaseCredits`, never activated as a standing.
 *
 * ### Building a subscribe from the catalog
 * **Example:** The command a tier implies
 * ```typescript
 * const input = subscribeInputOf(catalog, "pro", { anchorTz: "UTC" });
 * if (input !== null) yield* new Subscribe(input);
 * ```
 *
 * @primitive
 */
export const subscribeInputOf = (
  catalog: Catalog,
  tierId: string,
  options: {
    readonly anchorTz?: string;
    readonly currency?: string;
    readonly chargeId?: string;
  } = {},
): (TierGrantInput & { readonly anchorTz?: string }) | null => {
  const terms = planTermsOf(catalog, tierId, options.currency);

  if (terms === null || terms.kind === "one_off") return null;

  return {
    ...grantOf(tierId, terms),
    ...(options.anchorTz === undefined ? {} : { anchorTz: options.anchorTz }),
    ...(options.chargeId === undefined ? {} : { chargeId: options.chargeId }),
  };
};

/**
 * The input a `ScheduleTierChange` carries for a tier, or `null` when the
 * catalog does not sell it. A one-off pack is refused: scheduling a pack would
 * move the standing onto a bundle with no allowances at the boundary.
 *
 * ### Scheduling a move from the catalog
 * **Example:** The payload a console sends for the boundary
 * ```typescript
 * const input = scheduleTierChangeInputOf(catalog, "pro", currencyOf(standing));
 * if (input !== null) yield* new ScheduleTierChange(input);
 * ```
 *
 * @primitive
 */
export const scheduleTierChangeInputOf = (
  catalog: Catalog,
  tierId: string,
  currency?: string,
): TierGrantInput | null => {
  const terms = planTermsOf(catalog, tierId, currency);

  if (terms === null || terms.kind === "one_off") return null;

  return grantOf(tierId, terms);
};

/**
 * The input a `PurchaseCredits` carries for a one-off pack, or `null` when the
 * catalog lacks it or the tier is not a pack. `invoiceId` is the invoice an
 * auto top-up opened; a webhook purchase omits it.
 *
 * ### Buying a pack from the catalog
 * **Example:** The purchase a completed checkout records
 * ```typescript
 * const input = purchaseCreditsInputOf(catalog, "pack");
 * if (input !== null) yield* new PurchaseCredits(input);
 * ```
 *
 * @primitive
 */
export const purchaseCreditsInputOf = (
  catalog: Catalog,
  tierId: string,
  options: { readonly invoiceId?: string } = {},
): {
  readonly tier: string;
  readonly amount: number;
  readonly price?: Price;
  readonly invoiceId?: string;
  readonly rates: CreditRateCards;
} | null => {
  const terms = planTermsOf(catalog, tierId);

  if (terms === null || terms.kind !== "one_off") return null;

  return {
    tier: tierId,
    amount: terms.credits,
    ...(terms.price === undefined ? {} : { price: terms.price }),
    ...(options.invoiceId === undefined ? {} : { invoiceId: options.invoiceId }),
    rates: terms.rates,
  };
};

/** The input a `ChangeTier` carries, and the proration it moves. */
export interface ChangeTierPlan {
  readonly input: TierGrantInput & { readonly proration?: Proration };
  readonly proration: Proration | null;
}

/**
 * The `ChangeTier` a move implies, and the proration the same prices and period
 * would charge, or `null` when the catalog does not sell the tier or it is a
 * one-off pack.
 *
 * `Preview` and the admin apply path both call this, so a catalog field cannot
 * be added to one and forgotten in the other. The function is pure: `at` is the
 * same clock value the caller passes to `Subscription.predict` or to the
 * command that will decide it.
 *
 * ### Quoting a move before it is sent
 * **Example:** The command and the charge it carries
 * ```typescript
 * const plan = planChangeTier(catalog, "scale", state, now);
 * if (plan !== null) {
 *   yield* subscription.send(ref, new ChangeTier(plan.input), { commandId });
 *   return { due: plan.proration?.due ?? 0 };
 * }
 * ```
 *
 * @primitive
 */
export const planChangeTier = (
  catalog: Catalog,
  tierId: string,
  state: SubscriptionState,
  at: DateTime.Utc,
): ChangeTierPlan | null => {
  // The standing's currency is what the account was sold in. A move that
  // resolved the tier's base price instead would quote (and later guard) a
  // different currency than the one the standing carries.
  const terms = planTermsOf(
    catalog,
    tierId,
    state._tag === "Subscribed" ? currencyOf(state) : undefined,
  );

  if (terms === null || terms.kind === "one_off") return null;

  const proration =
    state._tag === "Subscribed"
      ? prorate({
          from: priceOf(state),
          to: terms.price,
          period: { start: state.period.start, end: state.period.end },
          at,
        })
      : null;

  return {
    input: {
      ...grantOf(tierId, terms),
      ...(proration === null ? {} : { proration }),
    },
    proration,
  };
};

/** The public spelling of `subscribeInputOf`. */
export const subscribePlanInputOf = subscribeInputOf;

/** The public spelling of `scheduleTierChangeInputOf`. */
export const schedulePlanChangeInputOf = scheduleTierChangeInputOf;
