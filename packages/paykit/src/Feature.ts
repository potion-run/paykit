import * as Schema from "effect/Schema";

/**
 * A feature's stable id: `messages`, `seats`, `storage_gb`. Branded so the
 * id carried by an allowance cannot be confused with an arbitrary string.
 */
export const FeatureId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("FeatureId"),
);
export type FeatureId = typeof FeatureId.Type;

/**
 * A meterable thing a tier grants. A feature is declared once in a catalog
 * and quoted by identity from every tier that grants it, so a typo is a
 * compile error rather than an allowance nobody can consume.
 */
export const Feature = Schema.Struct({
  id: FeatureId,
  name: Schema.optionalKey(Schema.String),
});
export type Feature = typeof Feature.Type;

/** A feature as an author writes it, before it gets its brand. */
export interface FeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
}

/**
 * Declare a feature. The catalog validates the id; this stays pure.
 *
 * ### Declaring a feature
 * **Example:** A built-in meter and an app's own
 * ```typescript
 * const messages = feature({ id: "messages", name: "Messages" });
 * const credits = feature({ id: "credits", name: "Credits" });
 * ```
 */
export const feature = (input: FeatureInput): Feature => ({
  id: input.id as FeatureId,
  ...(input.name === undefined ? {} : { name: input.name }),
});

/**
 * Declarations for the features paykit ships. Import them, or call
 * `feature()` for an app's own meter.
 */
export const messages = feature({ id: "messages", name: "Messages" });
export const seats = feature({ id: "seats", name: "Seats" });
export const storage_gb = feature({ id: "storage_gb", name: "Storage (GB)" });
