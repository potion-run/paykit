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

/** Credits per unit, keyed by the dimension a caller names. */
export const CreditRates = Schema.Record(Schema.String, Schema.Int);
export type CreditRates = typeof CreditRates.Type;

/** Every credit-priced feature's rate card, keyed by feature id. */
export const CreditRateCards = Schema.Record(Schema.String, CreditRates);
export type CreditRateCards = typeof CreditRateCards.Type;

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
  /**
   * What a unit costs in credits, keyed by the dimension that served it, with
   * a required `"default"`. A feature with a rate card is priced in credits and
   * draws on the account's pool instead of counting units of its own.
   */
  creditRates: Schema.optionalKey(CreditRates),
});
export type Feature = typeof Feature.Type;

/** A metered feature as an author writes it: counted, or priced in credits. */
export interface MeteredFeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** @default "metered" */
  readonly kind?: "metered";
  /**
   * Credits per unit by dimension. A rate card makes the feature credit-priced;
   * `"default"` is required so a caller that names no dimension is still priced.
   */
  readonly creditRates?: CreditRates & { readonly default: number };
}

/** A flag as an author writes it: on or off, so it has nothing to spend. */
export interface FlagFeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  readonly kind: "flag";
  /** A flag has no counter, so it cannot declare a rate card. */
  readonly creditRates?: never;
}

/** A feature as an author writes it, before it gets its brand. */
export type FeatureInput = MeteredFeatureInput | FlagFeatureInput;

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
 *
 * // A credit-priced feature: a unit costs credits by the dimension that
 * // served it, and the credits come out of the account's pool.
 * const ai = feature({
 *   id: "ai",
 *   name: "AI",
 *   creditRates: { default: 1, "gpt-large": 10 },
 * });
 * ```
 */
export function feature<const K extends FeatureKind = "metered">(input: {
  readonly id: string;
  readonly name?: string;
  readonly kind?: K;
  readonly creditRates?: "flag" extends K ? never : CreditRates & { readonly default: number };
}): Feature & { readonly kind: K };
export function feature(input: FeatureInput): Feature;
export function feature(input: {
  readonly id: string;
  readonly name?: string;
  readonly kind?: FeatureKind;
  readonly creditRates?: CreditRates;
}): Feature {
  return {
    id: input.id as FeatureId,
    ...(input.name === undefined ? {} : { name: input.name }),
    kind: input.kind ?? "metered",
    ...(input.creditRates === undefined ? {} : { creditRates: { ...input.creditRates } }),
  };
}

/**
 * Declarations for the features paykit ships. Import them, or call
 * `feature()` for an app's own meter.
 */
export const messages = feature({ id: "messages", name: "Messages" });
export const seats = feature({ id: "seats", name: "Seats" });
export const storage_gb = feature({ id: "storage_gb", name: "Storage (GB)" });
