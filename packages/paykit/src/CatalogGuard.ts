import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import type { Allowance } from "./Allowance.ts";
import { allowancesOf, creditRatesOf, tierOf } from "./Catalog.ts";
import { CatalogMismatch } from "./CatalogMismatch.rejection.ts";
import { CatalogService } from "./CatalogService.ts";
import type { Price } from "./Tier.ts";

/** The catalog-derived fields a command may carry on the wire. */
interface CatalogCarried {
  readonly tier?: string;
  readonly allowances?: Readonly<Record<string, Allowance>>;
  readonly price?: Price;
  readonly credits?: number;
  readonly creditsExpire?: string;
  readonly rates?: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
    allowance.carryOver === true,
    allowance.cap ?? null,
    allowance.unitPrice === undefined
      ? null
      : [allowance.unitPrice.amount, allowance.unitPrice.currency],
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

/** Every rate, dimension by dimension, in a stable order. */
const ratesKey = (rates: Readonly<Record<string, Readonly<Record<string, number>>>>): string =>
  JSON.stringify(
    Object.keys(rates)
      .sort()
      .map((feature) => [
        feature,
        Object.keys(rates[feature]!)
          .sort()
          .map((dimension) => [dimension, rates[feature]![dimension]]),
      ]),
  );

/**
 * Compare a command's catalog-derived fields with what the catalog says, and
 * name the first disagreement. Pure, so a test can call it without an Api.
 */
export const catalogMismatchOf = (
  catalog: Parameters<typeof tierOf>[0],
  input: CatalogCarried,
): CatalogMismatch | null => {
  if (input.tier === undefined) return null;
  const tier = tierOf(catalog, input.tier);
  if (tier === null) {
    return new CatalogMismatch({
      tier: input.tier,
      field: "tier",
      expected: "in catalog",
      actual: "missing",
    });
  }
  const granted = allowancesOf(catalog, input.tier);
  if (granted !== null && input.allowances !== undefined) {
    const expected = allowancesKey(granted);
    const actual = allowancesKey(input.allowances);
    if (expected !== actual) {
      return new CatalogMismatch({ tier: tier.id, field: "allowances", expected, actual });
    }
  }
  const expectedPrice = priceKey(tier.price);
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
  const expectedRates = ratesKey(creditRatesOf(catalog));
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
 *   rejects: [TierNotInCatalog, CurrencyMismatch, CatalogMismatch],
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
        const input = (payload as { readonly input?: CatalogCarried } | null)?.input;
        if (input === undefined) return effect;
        const mismatch = catalogMismatchOf(catalog, input);
        return mismatch === null ? effect : Effect.fail(mismatch);
      });
  }),
);
