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
 * Whether a feature is counted, or an on/off capability. A `flag` is granted
 * by a tier and has nothing to spend down: no counter, no overage, no reset.
 */
export const FeatureKind = Schema.Literals(["metered", "flag"]);
export type FeatureKind = typeof FeatureKind.Type;

/**
 * A meterable thing a tier grants. A feature is declared once in a catalog
 * and quoted by identity from every tier that grants it, so a typo is a
 * compile error rather than an allowance nobody can consume.
 */
export const Feature = Schema.Struct({
  id: FeatureId,
  name: Schema.optionalKey(Schema.String),
  /** A `metered` feature is counted; a `flag` is on or off. */
  kind: FeatureKind,
});
export type Feature = typeof Feature.Type;

/** A feature as an author writes it, before it gets its brand. */
export interface FeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** @default "metered" */
  readonly kind?: FeatureKind;
}

/**
 * Declare a feature. The catalog validates the id; this stays pure.
 *
 * ### Declaring a feature
 * **Example:** A built-in meter, an app's own, and an on/off capability
 * ```typescript
 * const messages = feature({ id: "messages", name: "Messages" });
 * const credits = feature({ id: "credits", name: "Credits" });
 *
 * // A flag is on or off: a tier grants it with `grant()`, and nothing counts.
 * const sso = feature({ id: "sso", name: "SSO", kind: "flag" });
 * ```
 */
export const feature = (input: FeatureInput): Feature => ({
  id: input.id as FeatureId,
  ...(input.name === undefined ? {} : { name: input.name }),
  kind: input.kind ?? "metered",
});

/**
 * Declarations for the features paykit ships. Import them, or call
 * `feature()` for an app's own meter.
 */
export const messages = feature({ id: "messages", name: "Messages" });
export const seats = feature({ id: "seats", name: "Seats" });
export const storage_gb = feature({ id: "storage_gb", name: "Storage (GB)" });
