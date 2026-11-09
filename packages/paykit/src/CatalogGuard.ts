import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { pricingOf, type Allowance, type Allowances } from "./Allowance.ts";
import {
  allowanceFaultOf,
  catalogFactsOf,
  planItemsOf,
  ratesOf,
  planOf,
  pricedInCatalog,
  type Catalog,
} from "./Catalog.ts";
import { CatalogMismatch } from "./CatalogMismatch.rejection.ts";
import { CatalogService } from "./CatalogService.ts";
import type { CreditRateCards } from "./Feature.ts";
import { pricingKey } from "./Pricing.ts";
import { priceFor, topUpKey, type Price, type Tier, type TopUpTerms } from "./Tier.ts";

/** The catalog-derived fields a command may carry on the wire. */
interface CatalogCarried {
  readonly tier?: string;
  readonly group?: string;
  readonly addOn?: boolean;
  readonly allowances?: Readonly<Record<string, Allowance>>;
  readonly price?: Price;
  readonly credits?: number;
  readonly creditsExpire?: string;
  readonly topUp?: TopUpTerms;
  readonly rates?: CreditRateCards;
  /** The catalog facts a customer-controls write names, keyed by feature id. */
  readonly features?: Readonly<Record<string, { readonly priced: boolean }>>;
}

/**
 * A stable key for everything an allowance says. Every field is here on
 * purpose: a command that carries a different `kind`, `carryOver`, ceiling or
 * price than the catalog states would record a standing the deploy never sold.
 */
// JSON arrays rather than delimiter-joined strings: every value here is
// caller-supplied, and a feature id or currency containing the separator must
// not be able to forge a different allowance's key.
const allowanceKey = (allowance: Allowance): string =>
  JSON.stringify([
    allowance.feature,
    allowance.kind ?? "metered",
    allowance.included,
    allowance.overage,
    allowance.resets,
    allowance.resetEvery ?? 1,
    allowance.carryOver === true,
    allowance.carryCap ?? null,
    allowance.cap ?? null,
    allowance.prorate ?? null,
    pricingOf(allowance) === null ? null : pricingKey(pricingOf(allowance)!),
    allowance.moneyCap ?? null,
  ]);

const allowancesKey = (allowances: Readonly<Record<string, Allowance>>): string =>
  JSON.stringify(
    Object.keys(allowances)
      .sort()
      .map((feature) => allowanceKey(allowances[feature]!)),
  );

/** Whether two allowance sets describe the same plan items, field for field. */
export const sameAllowances = (left: Allowances, right: Allowances): boolean =>
  allowancesKey(left) === allowancesKey(right);

/**
 * The first thing a bespoke allowance set gets wrong structurally, or `null`
 * when every item could have been declared in the catalog. It is the same
 * per-item rule the deploy runs (`allowanceFaultOf`), so a rule the catalog
 * states cannot be missing here: the difference is only that a bespoke set does
 * not have to equal the plan's `grants` (ADR 0041 §3).
 */
const bespokeMismatchOf = (
  catalog: Catalog,
  plan: Tier,
  allowances: Allowances,
): CatalogMismatch | null => {
  const entries = Object.entries(allowances);

  if (entries.length === 0) {
    return new CatalogMismatch({
      tier: plan.id,
      field: "allowances",
      expected: "at least one plan item",
      actual: "none",
    });
  }

  const facts = catalogFactsOf(catalog);

  for (const [feature, allowance] of entries) {
    // A record key and the item it holds are one feature spelled twice; a
    // disagreement would name one feature and grant another.
    if (allowance.feature !== feature) {
      return new CatalogMismatch({
        tier: plan.id,
        feature,
        field: "allowances",
        expected: feature,
        actual: allowance.feature,
      });
    }

    const fault = allowanceFaultOf(facts, plan, allowance);

    if (fault !== null) {
      return new CatalogMismatch({
        tier: plan.id,
        feature,
        field: "allowances",
        expected: "a valid catalog plan item",
        actual: fault._tag,
      });
    }
  }

  return null;
};

const priceKey = (price: Price | undefined): string =>
  price === undefined ? "free" : JSON.stringify([price.amount, price.currency, price.interval]);

/** Every card, rule and multiplier, in a stable order. */
const cardKey = (card: CreditRateCards[string]): string =>
  JSON.stringify([
    card.default,
    Object.entries(card.dimensions ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    (card.rules ?? []).map((rule) => [
      Object.entries(rule.match).sort(([left], [right]) => left.localeCompare(right)),
      rule.credits,
    ]),
    (card.multipliers ?? []).map((multiplier) => [
      Object.entries(multiplier.match).sort(([left], [right]) => left.localeCompare(right)),
      multiplier.factor ?? null,
      multiplier.add ?? null,
    ]),
  ]);

const ratesKey = (rates: CreditRateCards): string =>
  JSON.stringify(
    Object.keys(rates)
      .sort()
      .map((feature) => [feature, cardKey(rates[feature]!)]),
  );

/**
 * Compare a command's catalog-derived fields with what the catalog says, and
 * name the first disagreement. Pure, so a test can call it without an Api.
 */
export const catalogMismatchOf = (
  catalog: Parameters<typeof planOf>[0],
  input: CatalogCarried,
): CatalogMismatch | null => {
  // A controls write names features, not a tier, so this check comes before the
  // tier early return. `priced` is "some plan bills it postpaid", which is the
  // fact a spend limit needs; an alert needs no price (ADR 0038).
  if (input.features !== undefined) {
    for (const [featureId, fact] of Object.entries(input.features)) {
      const priced = pricedInCatalog(catalog, featureId);

      if (priced === null) {
        return new CatalogMismatch({
          feature: featureId,
          field: "features",
          expected: "in catalog",
          actual: "missing",
        });
      }

      const expected = priced ? "priced" : "unpriced";
      const actual = fact.priced ? "priced" : "unpriced";

      if (expected !== actual) {
        return new CatalogMismatch({ feature: featureId, field: "features", expected, actual });
      }
    }
  }

  if (input.tier === undefined) return null;
  const tier = planOf(catalog, input.tier);

  if (tier === null) {
    return new CatalogMismatch({
      tier: input.tier,
      field: "tier",
      expected: "in catalog",
      actual: "missing",
    });
  }

  // The group and the add-on flag are plan terms too: a caller that moves a
  // plan into another group would change which plan it replaces.
  const expectedGroup = tier.group ?? "";
  const actualGroup = input.group ?? "";

  if (expectedGroup !== actualGroup) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "group",
      expected: expectedGroup.length === 0 ? "default" : expectedGroup,
      actual: actualGroup.length === 0 ? "default" : actualGroup,
    });
  }

  if ((tier.addOn === true) !== (input.addOn === true)) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "addOn",
      expected: String(tier.addOn === true),
      actual: String(input.addOn === true),
    });
  }

  const granted = planItemsOf(catalog, input.tier);

  if (granted !== null && input.allowances !== undefined) {
    // A custom plan opts in to bespoke allowances: its `grants` are the default
    // a caller gets when it states none, so the command's set is judged by
    // shape rather than by equality. Every other plan keeps the exact rule
    // (ADR 0041 §3).
    if (tier.custom === true) {
      const bespoke = bespokeMismatchOf(catalog, tier, input.allowances);

      if (bespoke !== null) return bespoke;
    } else {
      const expected = allowancesKey(granted);
      const actual = allowancesKey(input.allowances);

      if (expected !== actual) {
        return new CatalogMismatch({ tier: tier.id, field: "allowances", expected, actual });
      }
    }
  }

  const expectedPrice = priceKey(
    tier.price === undefined
      ? undefined
      : (priceFor(tier.price, input.price?.currency ?? tier.price.currency) ?? undefined),
  );

  const actualPrice = priceKey(input.price);

  if (expectedPrice !== actualPrice) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "price",
      expected: expectedPrice,
      actual: actualPrice,
    });
  }

  // The credit terms decide what a request costs and when the pool runs out,
  // so a command that claims different ones never reaches `decide`.
  const expectedCredits = String(tier.credits ?? 0);
  const actualCredits = String(input.credits ?? 0);

  if (expectedCredits !== actualCredits) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "credits",
      expected: expectedCredits,
      actual: actualCredits,
    });
  }

  const expectedExpire = tier.creditsExpire ?? "period";
  const actualExpire = input.creditsExpire ?? "period";

  if (expectedExpire !== actualExpire) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "creditsExpire",
      expected: expectedExpire,
      actual: actualExpire,
    });
  }

  // The line at which a spend refills the pool is a plan term like the grant
  // itself: a caller that moves it would buy a pack the deploy never agreed to.
  // The whole line is compared — the threshold, the cooldown and the pack —
  // because a caller that changes any of them changes what a crossing costs.
  const expectedTopUp = topUpKey(tier.topUp);
  const actualTopUp = topUpKey(input.topUp);

  if (expectedTopUp !== actualTopUp) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "topUp",
      expected: expectedTopUp,
      actual: actualTopUp,
    });
  }

  const expectedRates = ratesKey(ratesOf(catalog, tier.id) ?? {});
  const actualRates = ratesKey(input.rates ?? {});

  if (expectedRates !== actualRates) {
    return new CatalogMismatch({
      tier: tier.id,
      field: "rates",
      expected: expectedRates,
      actual: actualRates,
    });
  }

  return null;
};

/**
 * The guard that keeps the log honest about money. A `Subscribe`,
 * `ChangeTier` or `StartTrial` carries the allowances and the price it will
 * record, because `decide` is pure and cannot look them up. A caller that
 * omits the price, or sends allowances its tier does not grant, is refused
 * with `CatalogMismatch` instead of writing a standing that can never be
 * reconciled against an invoice.
 *
 * A plan the catalog declares with `custom: true` is the one exception, and it
 * is the catalogue's choice rather than the caller's (ADR 0041): its `grants`
 * are a default, so a bespoke set is accepted when every item is one the
 * catalog could have declared for that plan. The price and the credit terms are
 * compared exactly for a custom plan too, so a bespoke deal changes what a
 * customer may use, never what the deployment charges.
 *
 * A catalog-owning sender — `Paykit.Subscribe`, the webhook translator — builds
 * the command from `CatalogService` and never needs this guard. It exists for
 * the surfaces where the caller is not the catalog's owner: HTTP, an MCP tool,
 * a CLI.
 *
 * ### Guarding a catalog-derived command
 * **Example:** A command an Api client may send
 * ```typescript
 * export class Subscribe extends Domain.Command("Subscribe", {
 *   target: AccountId,
 *   input: { tier: Schema.String, allowances: Allowances, price: Schema.optionalKey(Price) },
 *   events: [SubscriptionActivated],
 *   rejects: [PlanNotInCatalog, CurrencyMismatch, CatalogMismatch],
 *   middleware: [Session, CatalogGuard],
 * }) {}
 * ```
 *
 * @primitive
 */
export class CatalogGuard extends RpcMiddleware.Service<CatalogGuard>()("paykit/CatalogGuard", {
  error: CatalogMismatch,
}) {}

/**
 * The guard's Layer: it reads the catalog the deployment validated and refuses
 * what disagrees with it.
 *
 * @layer
 */
export const CatalogGuardLive = Layer.effect(
  CatalogGuard,
  Effect.gen(function* () {
    const catalog = yield* CatalogService;

    return (effect, { payload }) =>
      Effect.suspend(() => {
        // SAFETY: `payload` is the command's decoded input, which the Api
        // normalizes; the `input` key is the one a carried catalog uses, and a
        // command without it is left untouched below.
        const input = (payload as { readonly input?: CatalogCarried } | null)?.input;

        if (input === undefined) return effect;
        const mismatch = catalogMismatchOf(catalog, input);

        return mismatch === null ? effect : Effect.fail(mismatch);
      });
  }),
);
