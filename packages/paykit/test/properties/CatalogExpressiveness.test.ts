import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance, type Allowance } from "../../src/Allowance.ts";
import {
  catalog,
  defineCatalog,
  tierOf,
  type Catalog,
  type CatalogError,
} from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { priceOf, pricing, type PriceBandInput, type PricingInput } from "../../src/Pricing.ts";
import { priceFor, tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";

const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Ceiling = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Currency = Schema.Literals(["usd", "eur", "gbp"]);

const tagOfError = (error: CatalogError): string => error._tag as string;

const accepted = (catalogInput: Parameters<typeof defineCatalog>[0]): Catalog | null => {
  const result = defineCatalog(catalogInput);
  return Result.isFailure(result) ? null : result.success;
};

const refusedTag = (catalogInput: Parameters<typeof defineCatalog>[0]): string | null => {
  const result = defineCatalog(catalogInput);
  return Result.isFailure(result) ? tagOfError(result.failure) : null;
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const pricingTier = (pricingInput: PricingInput, currency: string) =>
  tier({
    id: "metered",
    price: { amount: 1_900, currency, interval: "month" },
    grants: [allowance(messages, { included: 0, overage: "bill", pricing: pricingInput })],
  });

const bandedCatalog = (pricingInput: PricingInput, currency: string) => ({
  features: [messages],
  tiers: [pricingTier(pricingInput, currency)],
});

/** The ceilings an author states, sorted and deduplicated, ending at `"inf"`. */
const ladderOf = (
  ceilings: ReadonlyArray<number>,
  amounts: ReadonlyArray<number>,
  currency: string,
): ReadonlyArray<PriceBandInput> => {
  const sorted = [...new Set(ceilings)].sort((left, right) => left - right);
  const ladder = sorted.map((upTo, index) => ({
    upTo,
    amount: amounts[Math.min(index, amounts.length - 1)]!,
    currency,
  }));
  if (ladder.length === 0) ladder.push({ upTo: 1, amount: amounts[0]!, currency });
  return [...ladder, { upTo: "inf", amount: amounts[amounts.length - 1]!, currency }];
};

describe("a price ladder the catalog can express", () => {
  /**
   * Validation is what makes a banded price safe to bill from: a ladder that
   * validates is ordered, ends at `"inf"` and agrees on currency, so
   * `priceOf` always has a band for every count. A graduated ladder never falls
   * as usage grows; a volume ladder charges the whole total at the band it
   * lands in.
   */
  it.effect("accepts an ordered ladder ending at inf, and prices every count", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals(["graduated", "volume"]),
          currency: Currency,
          ceilings: Schema.Array(Ceiling).pipe(
            Schema.check(Schema.isMinLength(1)),
            Schema.check(Schema.isMaxLength(3)),
          ),
          amounts: Schema.Array(Amount).pipe(
            Schema.check(Schema.isMinLength(1)),
            Schema.check(Schema.isMaxLength(3)),
          ),
          counts: Schema.Array(
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 300 }))),
          ).pipe(Schema.check(Schema.isMaxLength(6))),
        }),
      ),
      ({ kind, currency, ceilings, amounts, counts }) => {
        // A volume ladder is a discount ladder: the per-unit rate may not rise.
        const ordered = kind === "volume" ? [...amounts].sort((a, b) => b - a) : amounts;
        const bands = ladderOf(ceilings, ordered, currency);
        const input = { kind, currency, bands } as const;
        const banded = pricing(input);
        const rejected = refusedTag(bandedCatalog(input, currency));
        if (rejected !== null) return false;

        if (priceOf(banded, 0) !== 0) return false;
        const sortedCounts = [...counts].sort((a, b) => a - b);
        for (const count of sortedCounts) {
          if (priceOf(banded, count) < 0) return false;
          // Every count has a band that covers it, so no count prices to zero
          // just because the ladder ended early.
          const chosen =
            banded._tag === "unit"
              ? null
              : banded.bands.find((band) => band.upTo === "inf" || count <= band.upTo);
          if (chosen === undefined || chosen === null) return false;
          if (kind === "volume") {
            const landed =
              banded._tag === "volume"
                ? banded.bands.find((band) => band.upTo === "inf" || count <= band.upTo)
                : undefined;
            if (landed === undefined) return false;
            if (
              priceOf(banded, count) !==
              Math.ceil(count / (landed.unitPrice.units ?? 1)) * landed.unitPrice.amount
            ) {
              return false;
            }
          }
        }
        if (kind === "graduated") {
          for (let index = 1; index < sortedCounts.length; index += 1) {
            if (priceOf(banded, sortedCounts[index - 1]!) > priceOf(banded, sortedCounts[index]!)) {
              return false;
            }
          }
        }
        const resolved = tierOf(accepted(bandedCatalog(input, currency))!, "metered")!;
        return same(resolved.grants[0]!.pricing, banded);
      },
      { runs: 100, size: 30 },
    ),
  );

  it.effect("refuses a ladder out of order, unterminated, or in another currency", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals(["graduated", "volume"]),
          currency: Currency,
          low: Ceiling,
          high: Ceiling,
          amount: Amount,
        }),
      ),
      ({ kind, currency, low, high, amount }) => {
        const [small, large] = low <= high ? [low, high] : [high, low];
        const distinct = small === large ? [small, large + 1] : [small, large];
        const [first, second] = distinct as [number, number];

        const outOfOrder = {
          kind,
          currency,
          bands: [
            { upTo: second, amount, currency },
            { upTo: first, amount, currency },
            { upTo: "inf", amount, currency },
          ],
        } as const;
        if (refusedTag(bandedCatalog(outOfOrder, currency)) !== "CatalogPricingBand") return false;

        const unterminated = {
          kind,
          currency,
          bands: [{ upTo: first, amount, currency }],
        } as const;
        if (refusedTag(bandedCatalog(unterminated, currency)) !== "CatalogPricingBand")
          return false;

        const other = currency === "usd" ? "eur" : "usd";
        const mismatched = {
          kind,
          currency,
          bands: [
            { upTo: first, amount, currency: other },
            { upTo: "inf", amount, currency },
          ],
        } as const;
        return refusedTag(bandedCatalog(mismatched, currency)) === "CatalogPricingCurrency";
      },
      { runs: 80, size: 20 },
    ),
  );

  it("refuses a volume ladder whose per-unit rate rises", () => {
    const rising = {
      kind: "volume",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 2, currency: "usd" },
      ],
    } as const;
    expect(refusedTag(bandedCatalog(rising, "usd"))).toBe("CatalogVolumeRateRises");
  });
});

describe("a tier can be customized and sold in more than one currency", () => {
  /**
   * A variant is resolved before validation, so the runtime only ever sees a
   * complete tier: every field the variant does not state is the base's, and
   * every field it does state wins. The base itself is untouched.
   */
  it.effect("a variant inherits every field it does not state", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          baseAmount: Amount,
          baseCredits: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
          ),
          baseIncluded: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
          ),
          variantAmount: Schema.optionalKey(Amount),
          variantCredits: Schema.optionalKey(
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
          ),
          variantIncluded: Schema.optionalKey(
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          ),
          rename: Schema.optionalKey(Schema.Literals(["Annual", "Team"])),
        }),
      ),
      ({
        baseAmount,
        baseCredits,
        baseIncluded,
        variantAmount,
        variantCredits,
        variantIncluded,
        rename,
      }) => {
        const base = tier({
          id: "base",
          name: "Base",
          price: { amount: baseAmount, currency: "usd", interval: "month" },
          credits: baseCredits,
          grants: [allowance(messages, { included: baseIncluded })],
        });
        const variant = tier({
          id: "annual",
          variantOf: "base",
          ...(rename === undefined ? {} : { customize: { name: rename } }),
          ...(variantAmount === undefined &&
          variantCredits === undefined &&
          variantIncluded === undefined
            ? {}
            : {
                customize: {
                  ...(rename === undefined ? {} : { name: rename }),
                  ...(variantAmount === undefined
                    ? {}
                    : {
                        price: {
                          amount: variantAmount,
                          currency: "usd",
                          interval: "annual" as const,
                        },
                      }),
                  ...(variantCredits === undefined ? {} : { credits: variantCredits }),
                  ...(variantIncluded === undefined
                    ? {}
                    : { grants: [allowance(messages, { included: variantIncluded })] }),
                },
              }),
        });
        const resolved = accepted({ features: [messages], tiers: [base, variant] });
        if (resolved === null) return false;
        const annual = tierOf(resolved, "annual")!;
        const original = tierOf(resolved, "base")!;

        const name = rename ?? "Base";
        if (annual.name !== name) return false;
        if (original.name !== "Base") return false;
        if (annual.price?.amount !== (variantAmount ?? baseAmount)) return false;
        if (annual.price?.interval !== (variantAmount === undefined ? "month" : "annual"))
          return false;
        if (annual.credits !== (variantCredits ?? baseCredits)) return false;
        if (original.credits !== baseCredits) return false;
        const included = variantIncluded ?? baseIncluded;
        if ((annual.grants[0] as Allowance).included !== included) return false;
        if ((original.grants[0] as Allowance).included !== baseIncluded) return false;
        return annual.variantOf === undefined;
      },
      { runs: 100, size: 30 },
    ),
  );

  it("refuses a missing base and a cycle", () => {
    const orphan = tier({
      id: "orphan",
      variantOf: "missing",
      grants: [allowance(messages, { included: 1 })],
    });
    expect(refusedTag({ features: [messages], tiers: [orphan] })).toBe("CatalogUnknownVariant");

    const first = tier({
      id: "first",
      variantOf: "second",
      grants: [allowance(messages, { included: 1 })],
    });
    const second = tier({
      id: "second",
      variantOf: "first",
      grants: [allowance(messages, { included: 1 })],
    });
    expect(refusedTag({ features: [messages], tiers: [first, second] })).toBe(
      "CatalogVariantCycle",
    );
  });

  /**
   * An additional currency is a stated amount, never a conversion: `priceFor`
   * answers the base currency and every stated one, and `null` for a currency
   * the tier does not sell. `tierTermsOf` refuses that pairing before a command
   * is built.
   */
  it.effect("states each currency explicitly and never converts", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          baseAmount: Amount,
          baseCurrency: Currency,
          entries: Schema.Array(Schema.Struct({ currency: Currency, amount: Amount })).pipe(
            Schema.check(Schema.isMaxLength(3)),
          ),
        }),
      ),
      ({ baseAmount, baseCurrency, entries }) => {
        const seen = new Set([baseCurrency]);
        const additional = entries.filter((entry) => {
          if (seen.has(entry.currency)) return false;
          seen.add(entry.currency);
          return true;
        });
        const price = {
          amount: baseAmount,
          currency: baseCurrency,
          interval: "month" as const,
          ...(additional.length === 0 ? {} : { additionalCurrencies: additional }),
        };
        const source = accepted({
          features: [messages],
          tiers: [
            tier({
              id: "pro",
              price,
              credits: 0,
              grants: [allowance(messages, { included: 10 })],
            }),
          ],
        });
        if (source === null) return false;

        if (priceFor(price, baseCurrency)?.amount !== baseAmount) return false;
        for (const entry of additional) {
          if (priceFor(price, entry.currency)?.amount !== entry.amount) return false;
        }
        for (const unsold of ["usd", "eur", "gbp"] as const) {
          const expected =
            unsold === baseCurrency
              ? baseAmount
              : (additional.find((entry) => entry.currency === unsold)?.amount ?? null);
          if ((priceFor(price, unsold)?.amount ?? null) !== expected) return false;
        }

        const duplicate = accepted({
          features: [messages],
          tiers: [
            tier({
              id: "dup",
              price: {
                ...price,
                additionalCurrencies: [{ currency: baseCurrency, amount: baseAmount }],
              },
              grants: [allowance(messages, { included: 10 })],
            }),
          ],
        });
        return duplicate === null;
      },
      { runs: 100, size: 30 },
    ),
  );

  it("refuses an additional currency that repeats the base or another entry", () => {
    const duplicateBase = tier({
      id: "dup",
      price: {
        amount: 1_900,
        currency: "usd",
        interval: "month",
        additionalCurrencies: [{ currency: "usd", amount: 1_700 }],
      },
      grants: [allowance(messages, { included: 10 })],
    });
    expect(refusedTag({ features: [messages], tiers: [duplicateBase] })).toBe(
      "CatalogAdditionalCurrency",
    );

    const twice = tier({
      id: "twice",
      price: {
        amount: 1_900,
        currency: "usd",
        interval: "month",
        additionalCurrencies: [
          { currency: "eur", amount: 1_800 },
          { currency: "eur", amount: 1_700 },
        ],
      },
      grants: [allowance(messages, { included: 10 })],
    });
    expect(refusedTag({ features: [messages], tiers: [twice] })).toBe("CatalogAdditionalCurrency");
  });

  it("sells a tier in the currency a caller asks for", () => {
    const pro = tier({
      id: "pro",
      price: {
        amount: 1_900,
        currency: "usd",
        interval: "month",
        additionalCurrencies: [{ currency: "eur", amount: 1_800 }],
      },
      grants: [allowance(messages, { included: 10 })],
    });
    const source = Effect.runSync(catalog({ features: [messages], tiers: [pro] }));
    expect(priceFor(tierOf(source, "pro")!.price!, "eur")?.amount).toBe(1_800);
    expect(priceFor(tierOf(source, "pro")!.price!, "gbp")).toBe(null);
  });
});
