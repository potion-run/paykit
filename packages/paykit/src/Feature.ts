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
export const FeatureKind = Schema.Literals(["metered", "flag", "non_consumable"]);

export type FeatureKind = typeof FeatureKind.Type;

/**
 * Credits per unit, keyed by a dimension the caller names. This is the
 * authoring shorthand for the common case; a card with property matches and
 * multipliers is a {@link RateCard}.
 */
export const CreditRates = Schema.Record(Schema.String, Schema.Int);

export type CreditRates = typeof CreditRates.Type;

/** A property match: every key must equal the event's property. */
export const RateMatch = Schema.Record(Schema.String, Schema.String);

export type RateMatch = typeof RateMatch.Type;

/**
 * A rate that applies when an event's properties match. The first matching
 * rule wins; a rule with an empty match is the fallback after `default`.
 */
export const RateRule = Schema.Struct({
  match: RateMatch,
  /** Credits one unit costs when this rule matches. */
  credits: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export type RateRule = typeof RateRule.Type;

/**
 * A change to the chosen rate. Unlike a rule, every matching multiplier
 * applies: the final rate is `rate × all factors + all adds`, clamped at zero.
 */
export const RateMultiplier = Schema.Struct({
  match: RateMatch,
  /** Multiply the rate. `0.3` is a 70% discount, `2` doubles it. */
  factor: Schema.optionalKey(Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /** Add a fixed number of credits to the rate; it may be negative. */
  add: Schema.optionalKey(Schema.Int),
});

export type RateMultiplier = typeof RateMultiplier.Type;

/**
 * What one unit of a credit-priced feature costs. `default` prices an event
 * with no dimension and no matching rule; `dimensions` prices a named
 * dimension; `rules` price on the event's properties; `multipliers` adjust
 * whichever rate won. A card is data, so a command carries it and `decide`
 * needs no catalog.
 */
export const RateCard = Schema.Struct({
  default: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** A rate per named dimension, as the caller names it. */
  dimensions: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  ),
  /** Property matches, in declaration order; the first match wins. */
  rules: Schema.optionalKey(Schema.Array(RateRule)),
  /** Every matching multiplier applies. */
  multipliers: Schema.optionalKey(Schema.Array(RateMultiplier)),
});

export type RateCard = typeof RateCard.Type;

/** A card as an author writes it. */
export interface RateCardInput {
  /** The rate for an event with no dimension and no matching rule. */
  readonly default: number;
  readonly dimensions?: Readonly<Record<string, number>>;
  readonly rules?: ReadonlyArray<{
    readonly match: Readonly<Record<string, string>>;
    readonly credits: number;
  }>;
  readonly multipliers?: ReadonlyArray<{
    readonly match: Readonly<Record<string, string>>;
    readonly factor?: number;
    readonly add?: number;
  }>;
}

/** Every credit-priced feature's card, keyed by feature id. */
export const CreditRateCards = Schema.Record(Schema.String, RateCard);

export type CreditRateCards = typeof CreditRateCards.Type;

/**
 * Declare a card. Pure: the catalog validates the rates and the matches.
 *
 * ### Declaring a rate card
 * **Example:** A rule for a large machine, and a spot discount
 * ```typescript
 * rateCard({
 *   default: 1,
 *   rules: [{ match: { size: "large" }, credits: 16 }],
 *   multipliers: [{ match: { lifecycle: "spot" }, factor: 0.3 }],
 * });
 * ```
 */
export const rateCard = (input: RateCardInput): RateCard => ({
  default: input.default,
  ...(input.dimensions === undefined ? {} : { dimensions: { ...input.dimensions } }),
  ...(input.rules === undefined
    ? {}
    : {
        rules: input.rules.map((rule) => ({
          match: { ...rule.match },
          credits: rule.credits,
        })),
      }),
  ...(input.multipliers === undefined
    ? {}
    : {
        multipliers: input.multipliers.map((multiplier) => ({
          match: { ...multiplier.match },
          ...(multiplier.factor === undefined ? {} : { factor: multiplier.factor }),
          ...(multiplier.add === undefined ? {} : { add: multiplier.add }),
        })),
      }),
});

/**
 * Compile the `creditRates` shorthand into a card: every key but `default` is
 * a named dimension. A key literally named `dimensions` is a dimension here,
 * which is why the shorthand and the rich form have separate constructors.
 */
export const cardFromRates = (rates: CreditRates): RateCard => {
  const { default: fallback, ...dimensions } = rates;

  return {
    default: fallback ?? 0,
    ...(Object.keys(dimensions).length === 0 ? {} : { dimensions }),
  };
};

const matches = (
  match: Readonly<Record<string, string>>,
  properties: Readonly<Record<string, string>> | undefined,
): boolean =>
  properties !== undefined &&
  Object.entries(match).every(([key, value]) => properties[key] === value);

/**
 * The credits one unit costs under a card. A named dimension is a direct
 * lookup; otherwise a matching rule wins, then `default`. Every matching
 * multiplier then applies, and the result never goes below zero.
 */
export const creditRateOf = (
  card: RateCard,
  ask: { readonly dimension?: string; readonly properties?: Readonly<Record<string, string>> } = {},
): number => {
  const dimensionRate = ask.dimension === undefined ? undefined : card.dimensions?.[ask.dimension];
  const rule = card.rules?.find((candidate) => matches(candidate.match, ask.properties));
  const base = rule?.credits ?? dimensionRate ?? card.default;
  let rate = base;

  for (const multiplier of card.multipliers ?? []) {
    if (!matches(multiplier.match, ask.properties)) continue;
    rate = rate * (multiplier.factor ?? 1) + (multiplier.add ?? 0);
  }

  return Math.max(0, Math.round(rate));
};

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
  /**
   * The full rate card: named dimensions, property rules and multipliers. A
   * feature declares one of `creditRates` or `rateCard`, never both.
   */
  rateCard: Schema.optionalKey(RateCard),
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
  /** A full rate card: dimensions, property rules and multipliers. */
  readonly rateCard?: never;
}

/** A flag as an author writes it: on or off, so it has nothing to spend. */
export interface FlagFeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  readonly kind: "flag";
  /** A flag has no counter, so it cannot declare a rate card. */
  readonly creditRates?: never;
  readonly rateCard?: never;
}

/**
 * A quantity as an author writes it: seats, workspaces, storage. It is set,
 * not spent, so it is not priced in credits and does not carry a rate card.
 */
export interface NonConsumableFeatureInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  readonly kind: "non_consumable";
  readonly creditRates?: never;
  readonly rateCard?: never;
}

/** A feature as an author writes it, before it gets its brand. */
export type FeatureInput = MeteredFeatureInput | FlagFeatureInput | NonConsumableFeatureInput;

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
 *
 * // A card prices on the event's properties and adjusts the rate.
 * const compute = feature({
 *   id: "compute_minutes",
 *   name: "Compute minutes",
 *   rateCard: {
 *     default: 1,
 *     rules: [{ match: { size: "large" }, credits: 16 }],
 *     multipliers: [{ match: { lifecycle: "spot" }, factor: 0.3 }],
 *   },
 * });
 *
 * // A quantity is set, not spent: seats, workspaces, storage.
 * const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
 * ```
 */
export function feature<const K extends FeatureKind = "metered">(input: {
  readonly id: string;
  readonly name?: string;
  readonly kind?: K;
  readonly creditRates?: K extends "metered" ? CreditRates & { readonly default: number } : never;
  readonly rateCard?: K extends "metered" ? RateCardInput : never;
}): Feature & { readonly kind: K };
export function feature(input: FeatureInput): Feature;
export function feature(input: {
  readonly id: string;
  readonly name?: string;
  readonly kind?: FeatureKind;
  readonly creditRates?: CreditRates;
  readonly rateCard?: RateCardInput;
}): Feature {
  // SAFETY: the catalog schema validates the id when the feature is declared.
  return {
    id: input.id as FeatureId,
    ...(input.name === undefined ? {} : { name: input.name }),
    kind: input.kind ?? "metered",
    ...(input.creditRates === undefined ? {} : { creditRates: { ...input.creditRates } }),
    ...(input.rateCard === undefined ? {} : { rateCard: rateCard(input.rateCard) }),
  };
}

/**
 * Declarations for the features paykit ships. Import them, or call
 * `feature()` for an app's own meter.
 */
export const messages = feature({ id: "messages", name: "Messages" });
export const seats = feature({ id: "seats", name: "Seats" });
export const storage_gb = feature({ id: "storage_gb", name: "Storage (GB)" });
