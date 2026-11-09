import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { grant, type Allowance } from "../../src/Allowance.ts";
import { Catalog, defineCatalog, type CatalogInput } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { type Tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { rawAllowance as allowance, rawTier as tier } from "../support/Raw.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });

const Money = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 10_000 }))),
  currency: Schema.Literals(["usd", "eur"]),
  interval: Schema.Literals(["month", "annual"]),
});

const Included = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
  Schema.Literal("unlimited"),
]);

const UnitPrice = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  currency: Schema.Literals(["usd", "eur"]),
});

const AllowanceSpec = Schema.Struct({
  included: Included,
  overage: Schema.Literals(["block", "bill", "allow"]),
  resets: Schema.Literals(["month", "annual", "never"]),
  carryOver: Schema.optionalKey(Schema.Boolean),
  cap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  unitPrice: Schema.optionalKey(UnitPrice),
  moneyCap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
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
});

type TierSpec = typeof TierSpec.Type;

const PackSpec = Schema.Struct({
  credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  price: Money,
  cooldownMinutes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 120 }))),
});

type PackSpec = typeof PackSpec.Type;

const CatalogSpec = Schema.Struct({
  tiers: Schema.Array(TierSpec).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(3)),
  ),
  /** A pack to buy on the top-up line, so the wire covers the one `Duration` a catalog states. */
  pack: Schema.optionalKey(PackSpec),
});

/**
 * A catalog from a spec that is valid by construction: an unlimited allowance
 * only allows, a cap only caps a billed allowance, a carry only happens where a
 * period resets, and a unit price is stated in the tier's own currency.
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

const buildTier = (spec: TierSpec, index: number, pack: PackSpec | undefined): Tier => {
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
    ...(pack === undefined || spec.price === undefined
      ? {}
      : {
          topUp: {
            threshold: 100,
            cooldown: Duration.minutes(pack.cooldownMinutes),
            pack: "pack",
          },
        }),
    grants: atLeastOne,
  });
};

const buildPack = (spec: PackSpec): Tier =>
  tier({
    id: "pack",
    kind: "one_off",
    price: spec.price,
    credits: spec.credits,
    grants: [],
  });

const build = (spec: typeof CatalogSpec.Type): CatalogInput => ({
  features: [messages, ai, sso],
  tiers: [
    ...spec.tiers.map((declared, index) => buildTier(declared, index, spec.pack)),
    ...(spec.pack === undefined ? [] : [buildPack(spec.pack)]),
  ],
});

const accepted = (input: CatalogInput): Catalog | null => {
  const result = defineCatalog(input);

  return Result.isFailure(result) ? null : result.success;
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const CatalogCodec = Schema.toCodecJson(Catalog);

describe("the served catalog", () => {
  it.effect("is the same catalog after the wire the console reads it from", () =>
    assertProperty(
      Arbitrary.schema(CatalogSpec),
      (spec) => {
        const catalog = accepted(build(spec));

        if (catalog === null) return false;

        const wire = Schema.encodeSync(CatalogCodec)(catalog);
        // The wire form is JSON, not a structure that happens to serialize:
        // an RPC carries it through `JSON.parse`/`JSON.stringify` unchanged.
        const parsed = JSON.parse(JSON.stringify(wire));

        if (!same(parsed, wire)) return false;

        const received = Schema.decodeSync(CatalogCodec)(parsed);

        if (!same(Schema.encodeSync(CatalogCodec)(received), wire)) return false;

        // A client validates what arrived, exactly as `PaykitCatalogClient`
        // does, and gets the value the deploy validated, not a rewrite of it.
        const served = accepted(received);

        return served !== null && same(Schema.encodeSync(CatalogCodec)(served), wire);
      },
      { runs: 80, size: 30 },
    ),
  );
});
