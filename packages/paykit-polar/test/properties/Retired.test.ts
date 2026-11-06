import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  priceDeclarations,
  productNameOf,
  productNamePrefixOf,
  retiredProducts,
  type FoundProduct,
} from "../../src/Prices.ts";
import { assertProperty } from "../support/Property.ts";

const Word = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(8)),
);

/**
 * The name a product carries, relative to the catalog under test. A `declared`
 * product is one this stage still sells; `undeclared` is one this stage used to
 * sell; `elsewhere` is another stage's; `bare` is a name no stage wrote.
 */
const FoundSeed = Schema.Struct({
  kind: Schema.Literals(["declared", "undeclared", "elsewhere", "bare"]),
  /** Indexes into the catalog's tiers, or the suffix of an undeclared name. */
  index: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 }))),
  otherStage: Word,
  /** The `paykit_tier` metadata; `null` means the product carries none. */
  tier: Schema.NullOr(Word),
  archived: Schema.Boolean,
});

const Case = Schema.Struct({
  stage: Word,
  tiers: Schema.Array(Word).pipe(Schema.check(Schema.isMaxLength(6))),
  found: Schema.Array(FoundSeed).pipe(Schema.check(Schema.isMaxLength(10))),
});
type Case = typeof Case.Type;

const nameOf = (input: Case, seed: Case["found"][number]): string => {
  const declared = input.tiers.map((tier) => productNameOf(input.stage, tier));
  switch (seed.kind) {
    case "declared":
      // A tier the catalog still sells, when it has one.
      return declared.length === 0
        ? productNameOf(input.stage, `t${seed.index}`)
        : declared[seed.index % declared.length]!;
    case "undeclared":
      // A tier-shaped name this stage owns and the catalog never declared.
      return productNameOf(input.stage, `gone${seed.index}`);
    case "elsewhere":
      return productNameOf(seed.otherStage, `tier${seed.index}`);
    case "bare":
      return `tier${seed.index}`;
  }
};

/**
 * The sweep, and the same question asked a second way: is this product ours,
 * still sellable, and not in the catalog? Written out here rather than reusing
 * the filter, so a property compares two statements of the rule instead of one
 * statement with itself.
 */
const sweep = (input: Case) => {
  const price = { amount: 1_900, currency: "usd", interval: "month" as const };
  const declarations = priceDeclarations(
    Object.fromEntries(input.tiers.map((tier) => [tier, price])),
    input.stage,
  );
  const found: ReadonlyArray<FoundProduct> = input.found.map((seed, index) => ({
    id: `prod_${index}`,
    name: nameOf(input, seed),
    tier: seed.tier,
    archived: seed.archived,
  }));
  const retired = retiredProducts(declarations, found, input.stage);
  const declared = new Set(input.tiers.map((tier) => productNameOf(input.stage, tier)));
  const prefix = productNamePrefixOf(input.stage);
  const expected = found.filter(
    (product) =>
      !product.archived &&
      product.tier !== null &&
      product.name.startsWith(prefix) &&
      !declared.has(product.name),
  );
  return { declarations, found, retired, expected };
};

describe("the Polar archive sweep", () => {
  /**
   * The sweep archives exactly what is ours, still sellable and undeclared —
   * no more, and no less. Anything else is a product someone still sells, a
   * product another stage owns, or a product that is already archived.
   */
  it.effect("names every sellable, undeclared product of this stage, and nothing else", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const { retired, expected } = sweep(input);
        return (
          retired.length === expected.length &&
          retired.every((product, index) => product.id === expected[index]!.id)
        );
      },
      { runs: 200, size: 40 },
    ),
  );

  /**
   * Archiving is idempotent, which is what makes the sweep safe to run on every
   * deploy: what it turned off is archived, so a second pass finds nothing.
   */
  it.effect("finds nothing the second time", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const { declarations, found, retired } = sweep(input);
        const archived = new Set(retired.map((product) => product.id));
        const again = retiredProducts(
          declarations,
          found.map((product) => ({
            ...product,
            archived: product.archived || archived.has(product.id),
          })),
          input.stage,
        );
        return again.length === 0;
      },
      { runs: 120, size: 40 },
    ),
  );

  /**
   * A product the catalog still declares is never archived, whatever else it
   * looks like: re-declaring a tier must not turn its own product off.
   */
  it.effect("never archives a product the catalog still declares", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const { retired } = sweep(input);
        const declared = new Set(input.tiers.map((tier) => productNameOf(input.stage, tier)));
        return retired.every((product) => !declared.has(product.name));
      },
      { runs: 120, size: 20 },
    ),
  );

  /**
   * The prefix covers every name the stage sells — the sweep can find its own
   * products at all — and ends at a colon, so `prod` does not claim
   * `production`'s products.
   */
  it.effect("covers every name this stage sells, and ends at a colon", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ stage: Word, tier: Word })),
      ({ stage, tier }) => {
        const prefix = productNamePrefixOf(stage);
        return (
          productNameOf(stage, tier).startsWith(prefix) &&
          prefix.endsWith(":") &&
          !`paykit:${stage}production:${tier}`.startsWith(prefix)
        );
      },
      { runs: 100, size: 20 },
    ),
  );
});
