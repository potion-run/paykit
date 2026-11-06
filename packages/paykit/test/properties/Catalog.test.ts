import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { grant, type Allowance } from "../../src/Allowance.ts";
import type { CatalogInput } from "../../src/Catalog.ts";
import { defineCatalog, tierTermsOf, type Catalog } from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { type Tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import {
  rawAllowance as allowance,
  rawFeature as feature,
  rawTier as tier,
} from "../support/Raw.ts";

const messages = feature({ id: "messages", name: "Messages" });
const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });

const Money = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  currency: Schema.Literals(["usd", "eur"]),
  interval: Schema.Literals(["month", "annual"]),
});

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
  Schema.Literal("unlimited"),
]);

const UnitPriceSpec = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  currency: Schema.Literals(["usd", "eur"]),
});

const AllowanceSpec = Schema.Struct({
  included: IncludedSpec,
  overage: Schema.Literals(["block", "bill", "allow"]),
  resets: Schema.Literals(["month", "annual", "never"]),
  carryOver: Schema.optionalKey(Schema.Boolean),
  cap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  unitPrice: Schema.optionalKey(UnitPriceSpec),
  moneyCap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))),
  ),
});
type AllowanceSpec = typeof AllowanceSpec.Type;

const TierSpec = Schema.Struct({
  price: Schema.optionalKey(Money),
  messages: Schema.optionalKey(AllowanceSpec),
  sso: Schema.Boolean,
  credits: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  ),
  creditsExpire: Schema.optionalKey(Schema.Literals(["period", "never"])),
  /** A one-off pack: a price, credits, and no grants. */
  pack: Schema.optionalKey(
    Schema.Struct({
      credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
      price: Money,
    }),
  ),
});
type TierSpec = typeof TierSpec.Type;

const CatalogSpec = Schema.Struct({
  tiers: Schema.Array(TierSpec).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(3)),
  ),
});
type CatalogSpec = typeof CatalogSpec.Type;

/**
 * A catalog from a spec that is valid by construction: an unlimited allowance
 * only ever allows, a cap only ever caps a billed allowance, and a carry only
 * happens where a period resets. The validator must accept every one.
 */
const buildAllowance = (spec: AllowanceSpec, currency?: string): Allowance => {
  const overage =
    spec.included === "unlimited" ? "allow" : spec.unitPrice !== undefined ? "bill" : spec.overage;
  const unitPrice =
    spec.included === "unlimited" || spec.unitPrice === undefined
      ? undefined
      : { ...spec.unitPrice, currency: currency ?? spec.unitPrice.currency };
  return allowance(messages, {
    included: spec.included,
    overage,
    resets: spec.resets,
    ...(spec.carryOver === true && spec.resets !== "never" ? { carryOver: true } : {}),
    ...(spec.included !== "unlimited" && overage === "bill" && spec.cap !== undefined
      ? { cap: spec.cap }
      : {}),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(unitPrice !== undefined && spec.moneyCap !== undefined ? { moneyCap: spec.moneyCap } : {}),
  });
};

const buildPack = (
  spec: { readonly credits: number; readonly price: typeof Money.Type },
  index: number,
): Tier =>
  tier({
    id: `tier_${index}`,
    kind: "one_off",
    price: spec.price,
    credits: spec.credits,
    grants: [] as unknown as [Allowance, ...Allowance[]],
  });

const buildTier = (spec: TierSpec, index: number): Tier => {
  if (spec.pack !== undefined) return buildPack(spec.pack, index);
  const grants = [
    ...(spec.messages === undefined ? [] : [buildAllowance(spec.messages, spec.price?.currency)]),
    ...(spec.sso ? [grant(sso)] : []),
  ];
  const atLeastOne = grants.length === 0 ? [allowance(messages, { included: 100 })] : grants;
  return tier({
    id: `tier_${index}`,
    ...(spec.price === undefined ? {} : { price: spec.price }),
    ...(spec.credits === undefined ? {} : { credits: spec.credits }),
    ...(spec.credits === undefined || spec.creditsExpire === undefined
      ? {}
      : { creditsExpire: spec.creditsExpire }),
    grants: atLeastOne as [Allowance, ...Allowance[]],
  });
};

const build = (spec: CatalogSpec): CatalogInput => ({
  features: [messages, ai, sso],
  tiers: spec.tiers.map(buildTier),
});

const accepted = (input: CatalogInput): Catalog | null => {
  const result = defineCatalog(input);
  return Result.isFailure(result) ? null : result.success;
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

describe("catalog properties", () => {
  it.effect("every catalog built from valid parts validates and round-trips", () =>
    assertProperty(
      Arbitrary.schema(CatalogSpec),
      (spec) => {
        const input = build(spec);
        const catalog = accepted(input);
        if (catalog === null) return false;

        // Validation is a decode, not a rewrite: a catalog that passed is the
        // same catalog when it is validated again.
        const again = defineCatalog(catalog);
        if (Result.isFailure(again)) return false;
        if (!same(again.success, catalog)) return false;

        // Every term the catalog implies passes its own guard. A command built
        // by the catalog's owner must never be refused by the guard.
        for (const declared of catalog.tiers) {
          const terms = tierTermsOf(catalog, declared.id);
          if (terms === null) return false;
          const mismatch = catalogMismatchOf(catalog, { tier: declared.id, ...terms });
          if (mismatch !== null) return false;
        }

        return true;
      },
      { runs: 100, size: 30 },
    ),
  );

  it.effect("the guard names the field a command disagrees about", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          catalog: CatalogSpec,
          mutation: Schema.Literals([
            "tier",
            "allowances",
            "price",
            "credits",
            "creditsExpire",
            "rates",
            "cap",
            "unitPrice",
            "moneyCap",
          ]),
          tierIndex: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
        }),
      ),
      ({ catalog: spec, mutation, tierIndex }) => {
        const catalog = accepted(build(spec));
        if (catalog === null) return false;
        const declared = catalog.tiers[tierIndex % catalog.tiers.length]!;
        const terms = tierTermsOf(catalog, declared.id);
        if (terms === null) return false;

        const carried: Record<string, unknown> = { tier: declared.id, ...terms };
        let field: string;
        switch (mutation) {
          case "tier":
            carried.tier = "tier_that_does_not_exist";
            field = "tier";
            break;
          case "allowances": {
            const entry = Object.entries(terms.allowances)[0];
            if (entry === undefined) return true;
            const [feature, first] = entry;
            carried.allowances = {
              ...terms.allowances,
              [feature]: {
                ...first,
                included: first.included === "unlimited" ? 1 : first.included + 1,
              },
            };
            field = "allowances";
            break;
          }
          case "cap":
          case "unitPrice":
          case "moneyCap": {
            const entry = Object.entries(terms.allowances)[0];
            if (entry === undefined) return true;
            const [feature, first] = entry;
            const mutated =
              mutation === "cap"
                ? { ...first, cap: (first.cap ?? 0) + 1 }
                : mutation === "unitPrice"
                  ? {
                      ...first,
                      unitPrice: {
                        amount: (first.unitPrice?.amount ?? 0) + 1,
                        currency: first.unitPrice?.currency ?? terms.price?.currency ?? "usd",
                      },
                    }
                  : { ...first, moneyCap: (first.moneyCap ?? 0) + 1 };
            carried.allowances = { ...terms.allowances, [feature]: mutated };
            field = "allowances";
            break;
          }
          case "price":
            carried.price =
              terms.price === undefined
                ? { amount: 100, currency: "usd", interval: "month" as const }
                : { ...terms.price, amount: terms.price.amount + 1 };
            field = "price";
            break;
          case "credits":
            carried.credits = terms.credits + 1;
            field = "credits";
            break;
          case "creditsExpire":
            carried.creditsExpire = terms.creditsExpire === "period" ? "never" : "period";
            field = "creditsExpire";
            break;
          case "rates":
            carried.rates = {
              ...terms.rates,
              ai: { ...terms.rates.ai, default: (terms.rates.ai?.default ?? 1) + 1 },
            };
            field = "rates";
            break;
        }

        const mismatch = catalogMismatchOf(catalog, carried as never);
        return mismatch !== null && mismatch.field === field;
      },
      { runs: 100, size: 30 },
    ),
  );
});
