import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Allowances, type Allowance } from "./Allowance.ts";
import { Feature } from "./Feature.ts";
import { Tier } from "./Tier.ts";

/**
 * The deploy-time catalog: every declared feature and every purchasable tier.
 * It is plain data, so it serializes into stack state and a runtime layer
 * without functions hiding in it. It is not an Alchemy `Resource` on purpose:
 * `BillingStack` is the resource, and the catalog is its validated desired
 * state.
 */
export const Catalog = Schema.Struct({
  features: Schema.Array(Feature),
  tiers: Schema.Array(Tier),
});
export type Catalog = typeof Catalog.Type;

/** A catalog as an author writes it. */
export interface CatalogInput {
  readonly features: ReadonlyArray<Feature>;
  readonly tiers: ReadonlyArray<Tier>;
}

/** The same feature id was declared twice. */
export class CatalogDuplicateFeature extends Schema.TaggedError<CatalogDuplicateFeature>()(
  "CatalogDuplicateFeature",
  { feature: Schema.String },
) {}

/** The same tier id was declared twice. */
export class CatalogDuplicateTier extends Schema.TaggedError<CatalogDuplicateTier>()(
  "CatalogDuplicateTier",
  { tier: Schema.String },
) {}

/** A tier quotes the same feature twice. */
export class CatalogDuplicateAllowance extends Schema.TaggedError<CatalogDuplicateAllowance>()(
  "CatalogDuplicateAllowance",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A tier grants a feature the catalog never declared. */
export class CatalogUnknownFeature extends Schema.TaggedError<CatalogUnknownFeature>()(
  "CatalogUnknownFeature",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A tier with no grants could never activate, so it is refused at deploy. */
export class CatalogEmptyTier extends Schema.TaggedError<CatalogEmptyTier>()("CatalogEmptyTier", {
  tier: Schema.String,
}) {}

/** A value that does not satisfy the catalog schema, with its path in `message`. */
export class CatalogInvalid extends Schema.TaggedError<CatalogInvalid>()("CatalogInvalid", {
  message: Schema.String,
}) {}

/** Every way `catalog()` can refuse, as one tagged union. */
export const CatalogError = Schema.Union([
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogDuplicateAllowance,
  CatalogUnknownFeature,
  CatalogEmptyTier,
  CatalogInvalid,
]);
export type CatalogError = typeof CatalogError.Type;

const duplicateOf = <A>(values: ReadonlyArray<A>, key: (value: A) => string): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
};

/**
 * Validate a catalog: the schema first, then the references the schema cannot
 * see — duplicate declarations, a grant with no declared feature, a tier that
 * grants nothing. Provider ids never appear here, so the same catalog runs on
 * every provider.
 *
 * ### Validating a catalog
 * **Example:** A free and a priced tier, both quoting one declared feature
 * ```typescript
 * const messages = feature({ id: "messages", name: "Messages" });
 *
 * const free = tier({
 *   id: "free",
 *   grants: [allowance(messages, { included: 100 })],
 * });
 * const pro = tier({
 *   id: "pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * const result = defineCatalog({ features: [messages], tiers: [free, pro] });
 * ```
 */
export const defineCatalog = (input: CatalogInput): Result.Result<Catalog, CatalogError> => {
  const decoded = Schema.decodeResult(Catalog)(input);
  if (Result.isFailure(decoded)) {
    return Result.fail(new CatalogInvalid({ message: decoded.failure.message }));
  }
  const catalog = decoded.success;

  const duplicateFeature = duplicateOf(catalog.features, (feature) => feature.id);
  if (duplicateFeature !== null) {
    return Result.fail(new CatalogDuplicateFeature({ feature: duplicateFeature }));
  }

  const duplicateTier = duplicateOf(catalog.tiers, (tier) => tier.id);
  if (duplicateTier !== null) {
    return Result.fail(new CatalogDuplicateTier({ tier: duplicateTier }));
  }

  const declared = new Set(catalog.features.map((feature) => feature.id));
  for (const tier of catalog.tiers) {
    if (tier.grants.length === 0) {
      return Result.fail(new CatalogEmptyTier({ tier: tier.id }));
    }
    const granted = new Set<string>();
    for (const grant of tier.grants) {
      if (!declared.has(grant.feature)) {
        return Result.fail(new CatalogUnknownFeature({ tier: tier.id, feature: grant.feature }));
      }
      if (granted.has(grant.feature)) {
        return Result.fail(
          new CatalogDuplicateAllowance({ tier: tier.id, feature: grant.feature }),
        );
      }
      granted.add(grant.feature);
    }
  }

  return Result.succeed(catalog);
};

/**
 * The effectful form, for a `Stack` or a runtime binding. A failure is the
 * same tagged union `defineCatalog()` returns.
 *
 * ### In a Stack
 * **Example:** Refuse a bad catalog at deploy time
 * ```typescript
 * const billing = yield* Stack("Billing", {
 *   catalog: { features: [messages], tiers: [free, pro] },
 *   providers: [Memory()],
 * });
 * ```
 */
export const catalog = (input: CatalogInput): Effect.Effect<Catalog, CatalogError> =>
  Effect.fromResult(defineCatalog(input));

/** A declared tier, or `null` when the catalog has no such tier. */
export const tierOf = (catalog: Catalog, tierId: string): Tier | null =>
  catalog.tiers.find((tier) => tier.id === tierId) ?? null;

/** A declared feature, or `null` when the catalog has no such feature. */
export const featureOf = (catalog: Catalog, featureId: string): Feature | null =>
  catalog.features.find((feature) => feature.id === featureId) ?? null;

/** Fold a tier's `grants` into the map a command and a view carry. */
export const allowancesOf = (catalog: Catalog, tierId: string): Allowances | null => {
  const tier = tierOf(catalog, tierId);
  if (tier === null) return null;
  const allowances: Record<string, Allowance> = {};
  for (const grant of tier.grants) allowances[grant.feature] = grant;
  return allowances;
};
