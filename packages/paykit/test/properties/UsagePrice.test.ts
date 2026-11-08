import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { defineCatalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import {
  pricing,
  pricingKey,
  unitsOf,
  type PriceBandInput,
  type Pricing,
  type PricingInput,
  type UnitPrice,
} from "../../src/Pricing.ts";
import type { ProviderDescriptor } from "../../src/Stack.ts";
import { validateProviderMappings } from "../../src/Stack.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";

const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Units = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 })));
const Ceiling = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));

const UnitPriceSpec = Schema.Struct({
  amount: Amount,
  units: Schema.optionalKey(Units),
});

const BandSpec = Schema.Struct({
  upTo: Ceiling,
  amount: Amount,
  units: Schema.optionalKey(Units),
});

const PricingSpec = Schema.Union([
  Schema.TaggedStruct("unit", { unitPrice: UnitPriceSpec }),
  Schema.TaggedStruct("banded", {
    kind: Schema.Literals(["graduated", "volume"]),
    bands: Schema.Array(BandSpec).pipe(Schema.check(Schema.isMaxLength(3))),
  }),
]);

type PricingSpec = typeof PricingSpec.Type;

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const messagesFeature = messages;
const ghostPrice: UnitPrice = { amount: 1, currency: "usd" };

const ladderOf = (
  bands: ReadonlyArray<typeof BandSpec.Type>,
  kind: "graduated" | "volume",
): ReadonlyArray<PriceBandInput> => {
  const sorted = [...bands].sort((left, right) => left.upTo - right.upTo);
  const seen = new Set<number>();
  const amounts = kind === "volume" ? bands.map((band) => band.amount).sort((a, b) => b - a) : null;
  const ladder: Array<PriceBandInput> = [];

  for (const [index, band] of sorted.entries()) {
    if (seen.has(band.upTo)) continue;
    seen.add(band.upTo);
    ladder.push({
      upTo: band.upTo,
      amount: amounts?.[Math.min(index, amounts.length - 1)] ?? band.amount,
      currency: "usd",
      // A volume ladder's discount is per unit; a generated package size could
      // make the normalized rate rise and the catalog would refuse it.
      ...(band.units === undefined || kind === "volume" ? {} : { units: band.units }),
    });
  }

  if (ladder.length === 0) ladder.push({ upTo: "inf", amount: 1, currency: "usd" });
  ladder[ladder.length - 1] = { ...ladder[ladder.length - 1]!, upTo: "inf" };

  return ladder;
};

const inputOf = (spec: PricingSpec): PricingInput =>
  spec._tag === "unit"
    ? { kind: "unit", ...spec.unitPrice, currency: "usd" }
    : { kind: spec.kind, currency: "usd", bands: ladderOf(spec.bands, spec.kind) };

const catalogOf = (input: PricingInput) =>
  defineCatalog({
    features: [messagesFeature],
    tiers: [
      tier({
        id: "metered",
        price,
        grants: [allowance(messagesFeature, { included: 0, overage: "bill", pricing: input })],
      }),
    ],
  });

const providerOf = (
  maps: {
    readonly usagePrices?: Readonly<Record<string, Readonly<Record<string, Pricing>>>>;
    readonly unitPrices?: Readonly<Record<string, Readonly<Record<string, UnitPrice>>>>;
  } = {},
): ProviderDescriptor => ({
  name: "memory",
  kind: "memory",
  webhook: false,
  capabilities: ["checkout", "usage"],
  prices: { metered: price },
  ...maps,
});

/** A unit price as the mismatch evidence spells it. */
const textOf = (unitPrice: UnitPrice): string =>
  unitsOf(unitPrice) === 1
    ? `${unitPrice.amount} ${unitPrice.currency}`
    : `${unitPrice.amount} ${unitPrice.currency} per ${unitsOf(unitPrice)} units`;

const withAmount = (built: Pricing): Pricing => {
  if (built._tag === "unit") {
    return {
      _tag: "unit",
      unitPrice: { ...built.unitPrice, amount: built.unitPrice.amount + 1 },
    };
  }

  const [first, ...rest] = built.bands;

  return {
    ...built,
    bands: [
      { ...first, unitPrice: { ...first.unitPrice, amount: first.unitPrice.amount + 1 } },
      ...rest,
    ],
  };
};

const withOtherTag = (built: Pricing): Pricing =>
  built._tag === "unit"
    ? {
        _tag: "volume",
        currency: built.unitPrice.currency,
        bands: [{ upTo: "inf", unitPrice: built.unitPrice }],
      }
    : {
        _tag: built._tag === "graduated" ? "volume" : "graduated",
        currency: built.currency,
        bands: built.bands,
      };

const mismatchOf = (result: ReturnType<typeof validateProviderMappings>) =>
  result !== null && result._tag === "CatalogPriceMismatch" ? result : null;

describe("a provider that holds the full usage pricing", () => {
  /**
   * A package or a ladder cannot be stated as one unit price. The provider
   * declares the whole `Pricing`, and the deploy compares it with the catalog
   * by its identity — amount, package size, bands and mode — so a vendor that
   * holds a different ladder is refused before it bills a period.
   */
  it.effect("accepts the pricing the catalog states and refuses any other", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          pricing: PricingSpec,
          mapping: Schema.Literals(["correct", "amount", "tag", "extra"]),
        }),
      ),
      ({ pricing: spec, mapping }) => {
        const catalog = catalogOf(inputOf(spec));

        if (Result.isFailure(catalog)) return false;
        const built = pricing(inputOf(spec));

        const mapped =
          mapping === "amount"
            ? withAmount(built)
            : mapping === "tag"
              ? withOtherTag(built)
              : built;

        const usagePrices: Record<string, Record<string, Pricing>> = mapping === "extra"
          ? {
              metered: {
                messages: built,
                ghost: { _tag: "unit", unitPrice: ghostPrice },
              },
            }
          : { metered: { messages: mapped } };

        const result = validateProviderMappings(catalog.success, [providerOf({ usagePrices })]);

        if (mapping === "correct") return result === null;
        const mismatch = mismatchOf(result);

        if (mismatch === null) return false;

        if (mapping === "extra") {
          return (
            mismatch.field === "pricing.ghost" &&
            mismatch.expected === "none" &&
            mismatch.actual === pricingKey({ _tag: "unit", unitPrice: ghostPrice })
          );
        }

        return (
          mismatch.field === "pricing.messages" &&
          mismatch.expected === pricingKey(built) &&
          mismatch.actual === pricingKey(mapped)
        );
      },
      { runs: 100, size: 30 },
    ),
  );

  /**
   * The one-rate shorthand is still accepted, but it has to agree on the
   * package size as well as the amount: `$5 per 1,000` and `$5 per unit` are
   * different prices. A full `usagePrices` statement wins over the shorthand,
   * so a deploy that holds the ladder does not also have to restate it.
   */
  it.effect(
    "checks the shorthand's amount and package size unless the full pricing covers it",
    () =>
      assertProperty(
        Arbitrary.schema(
          Schema.Struct({
            amount: Amount,
            units: Units,
            mapping: Schema.Literals(["correct", "amount", "units", "absent"]),
            full: Schema.Boolean,
          }),
        ),
        ({ amount, units, mapping, full }) => {
          const input = { kind: "unit" as const, amount, units, currency: "usd" };
          const catalog = catalogOf(input);

          if (Result.isFailure(catalog)) return false;
          const built = pricing(input);

          const mapped: UnitPrice = {
            amount: mapping === "amount" ? amount + 1 : amount,
            currency: "usd",
            units: mapping === "units" ? units + 1 : units,
          };

          const shorthand =
            mapping === "absent" ? {} : { unitPrices: { metered: { messages: mapped } } };

          const result = validateProviderMappings(catalog.success, [
            providerOf({
              ...(full ? { usagePrices: { metered: { messages: built } } } : {}),
              ...shorthand,
            }),
          ]);

          if (full || mapping === "correct") return result === null;
          const mismatch = mismatchOf(result);

          if (mismatch === null) return false;

          return (
            mismatch.field === "unitPrice.messages" &&
            mismatch.expected === textOf({ amount, currency: "usd", units }) &&
            mismatch.actual === (mapping === "absent" ? "missing" : textOf(mapped))
          );
        },
        { runs: 100, size: 30 },
      ),
  );

  it.effect("accepts a ladder only when the provider states the full pricing", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          low: Ceiling,
          first: Amount,
          second: Amount,
          mapping: Schema.Literals(["full", "shorthand", "absent"]),
        }),
      ),
      ({ low, first: firstAmount, second: secondAmount, mapping }) => {
        // Two bands, so the pricing has no single rate the shorthand could
        // state; a one-band ladder would still be a one-rate price.
        const input = {
          kind: "graduated" as const,
          currency: "usd",
          bands: [
            { upTo: low, amount: firstAmount, currency: "usd" },
            { upTo: "inf" as const, amount: secondAmount, currency: "usd" },
          ],
        };

        const catalog = catalogOf(input);

        if (Result.isFailure(catalog)) return false;
        const built = pricing(input);
        const first = built._tag === "unit" ? built.unitPrice : built.bands[0]!.unitPrice;

        const result = validateProviderMappings(catalog.success, [
          providerOf({
            ...(mapping === "full" ? { usagePrices: { metered: { messages: built } } } : {}),
            ...(mapping === "shorthand" ? { unitPrices: { metered: { messages: first } } } : {}),
          }),
        ]);

        if (mapping === "full") return result === null;
        const mismatch = mismatchOf(result);

        if (mismatch === null) return false;

        if (mapping === "shorthand") {
          return (
            mismatch.field === "unitPrice.messages" &&
            mismatch.expected === "none" &&
            mismatch.actual === textOf(first)
          );
        }

        return (
          mismatch.field === "pricing.messages" &&
          mismatch.expected === "a pricing the provider can meter" &&
          mismatch.actual === pricingKey(built)
        );
      },
      { runs: 80, size: 30 },
    ),
  );

  it("refuses a usage pricing for a tier the catalog never declares", () => {
    const catalog = Result.getOrThrow(catalogOf({ kind: "unit", amount: 1, currency: "usd" }));

    const result = validateProviderMappings(catalog, [
      {
        ...providerOf({
          usagePrices: {
            other: { messages: pricing({ kind: "unit", amount: 1, currency: "usd" }) },
          },
        }),
        prices: { metered: price },
      },
    ]);

    expect(result?._tag).toBe("CatalogPriceMismatch");

    if (result?._tag === "CatalogPriceMismatch") {
      expect(result.field).toBe("usagePrices");
      expect(result.actual).toBe("missing");
    }
  });
});
