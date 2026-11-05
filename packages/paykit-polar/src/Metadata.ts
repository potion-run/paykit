// Adapted from `@alchemy.run/stripe@2.0.0-beta.85` (`src/Metadata.ts`), the
// Alchemy Stripe provider's mapping of Alchemy ownership tags onto a vendor's
// metadata constraints. Polar's limits are the same: keys are at most 40
// characters and may only use alphanumerics, dashes and underscores; values are
// at most 500. Alchemy's `alchemy::stack` / `alchemy::stage` / `alchemy::id`
// tags therefore become `alchemy_stack` / `alchemy_stage` / `alchemy_id`.
import { createInternalTags, diffTags, hasTags, type Tags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

export const ALCHEMY_METADATA_PREFIX = "alchemy_";

export const alchemyMetadataKeys = {
  stack: "alchemy_stack",
  stage: "alchemy_stage",
  id: "alchemy_id",
} as const;

const TAG_PREFIX = "alchemy::";

export const toMetadataKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_METADATA_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

/** Polar metadata values are capped at 500 characters. */
export const sanitizeMetadataValue = (value: string): string => value.slice(0, 500);

export const toMetadata = (
  tags: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [
      toMetadataKey(key).slice(0, 40),
      sanitizeMetadataValue(value),
    ]),
  );

export const createInternalMetadata = Effect.fn(function* (id: string) {
  return toMetadata(yield* createInternalTags(id));
});

export const hasAlchemyMetadata = Effect.fn(function* (id: string, metadata: Tags | undefined) {
  const expected = yield* createInternalMetadata(id);
  return hasTags(expected, metadata);
});

/** Diff observed metadata against desired metadata; always pass what the vendor returned. */
export const diffMetadata = diffTags;
