import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { pricingOf, type Allowance } from "./Allowance.ts";
import { planItemsOf, ratesOf, planOf, pricedInCatalog } from "./Catalog.ts";
import { CatalogMismatch } from "./CatalogMismatch.rejection.ts";
import { CatalogService } from "./CatalogService.ts";
import type { CreditRateCards } from "./Feature.ts";
import { pricingKey } from "./Pricing.ts";
import { priceFor, topUpKey, type Price, type TopUpTerms } from "./Tier.ts";

/** The catalog-derived fields a command may carry on the wire. */
interface CatalogCarried {
  readonly tier?: string;
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

  const granted = planItemsOf(catalog, input.tier);

  if (granted !== null && input.allowances !== undefined) {
    const expected = allowancesKey(granted);
    const actual = allowancesKey(input.allowances);

    if (expected !== actual) {
      return new CatalogMismatch({ tier: tier.id, field: "allowances", expected, actual });
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
