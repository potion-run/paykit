import * as Schema from "effect/Schema";

/**
 * How many feature units one price buys. A price of `$5 per 1,000` is
 * `{ amount: 500, currency: "usd", units: 1_000 }`; the default of `1` is the
 * ordinary per-unit price.
 */
export const BillingUnits = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type BillingUnits = typeof BillingUnits.Type;

/**
 * Money for a package of units: integer minor units, one currency, and how
 * many units the amount buys. The amount is never a float, so the same catalog
 * decodes to the same integer on every machine.
 */
export const UnitPrice = Schema.Struct({
  /** Minor units, in `currency`. */
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** How many feature units `amount` buys. Defaults to one. */
  units: Schema.optionalKey(BillingUnits),
});
export type UnitPrice = typeof UnitPrice.Type;

/**
 * The identity of a unit price in a log or a read model. Two prices are the
 * same price exactly when this is, so a mid-period change — an amount, a
 * currency or a package size — is a different key and the close reports the
 * units separately.
 */
export const priceKey = (price: UnitPrice): string =>
  price.units === undefined || price.units === 1
    ? `${price.currency}:${price.amount}`
    : `${price.currency}:${price.amount}:${price.units}`;

/** The identity of a whole pricing, for a report that names its rate card. */
export const pricingKey = (pricing: Pricing): string =>
  pricing._tag === "unit"
    ? `unit:${priceKey(pricing.unitPrice)}`
    : `${pricing._tag}:${pricing.bands
        .map((band) => `${band.upTo === "inf" ? "inf" : band.upTo}=${priceKey(band.unitPrice)}`)
        .join(",")}`;

/** One band of a graduated or volume price. `upTo: "inf"` is the last band. */
export const PriceBand = Schema.Struct({
  /** The band covers `(previous upTo, upTo]`. The last band must be `"inf"`. */
  upTo: Schema.Union([
    Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    Schema.Literal("inf"),
  ]),
  unitPrice: UnitPrice,
});
export type PriceBand = typeof PriceBand.Type;

/** A band as an author writes it: a ceiling and what the units in it cost. */
export interface PriceBandInput {
  readonly upTo: number | "inf";
  readonly amount: number;
  readonly currency: string;
  /** How many feature units `amount` buys. Defaults to one. */
  readonly units?: number;
}

const band = (input: PriceBandInput): PriceBand => ({
  upTo: input.upTo,
  unitPrice: {
    amount: input.amount,
    currency: input.currency,
    ...(input.units === undefined ? {} : { units: input.units }),
  },
});

/**
 * How a billed unit is priced. `unit` is one rate for every unit; `graduated`
 * charges each band's own rate for the units that fall in it; `volume` charges
 * every unit at the rate of the band the total lands in. A pricing is a pure
 * function of the billable count, which is what lets one event's charge be the
 * difference between the price before and after it.
 */
export const Pricing = Schema.Union([
  Schema.TaggedStruct("unit", { unitPrice: UnitPrice }),
  Schema.TaggedStruct("graduated", {
    currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    bands: Schema.NonEmptyArray(PriceBand),
  }),
  Schema.TaggedStruct("volume", {
    currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    bands: Schema.NonEmptyArray(PriceBand),
  }),
]);
export type Pricing = typeof Pricing.Type;

/** A pricing as an author writes it. */
export type PricingInput =
  | {
      readonly kind: "unit";
      readonly amount: number;
      readonly currency: string;
      /** How many feature units `amount` buys. Defaults to one. */
      readonly units?: number;
    }
  | {
      readonly kind: "graduated" | "volume";
      readonly currency: string;
      readonly bands: ReadonlyArray<PriceBandInput>;
    };

/**
 * Declare a price. Pure: the catalog validates the bands and the currencies.
 *
 * ### Declaring a price
 * **Example:** A per-unit price, a package price, and two bands
 * ```typescript
 * pricing({ kind: "unit", amount: 2, currency: "usd" });
 * // { _tag: "unit", unitPrice: { amount: 2, currency: "usd" } }
 *
 * // $5 for each 1,000 units.
 * pricing({ kind: "unit", amount: 500, currency: "usd", units: 1_000 });
 *
 * // The first 10,000 units at $0.01, then $0.005.
 * pricing({
 *   kind: "graduated",
 *   currency: "usd",
 *   bands: [
 *     { upTo: 10_000, amount: 1, currency: "usd" },
 *     { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
 *   ],
 * });
 * ```
 */
export const pricing = (input: PricingInput): Pricing => {
  if (input.kind === "unit") {
    return {
      _tag: "unit",
      unitPrice: {
        amount: input.amount,
        currency: input.currency,
        ...(input.units === undefined ? {} : { units: input.units }),
      },
    };
  }
  return {
    _tag: input.kind,
    currency: input.currency,
    bands: [band(input.bands[0]!), ...input.bands.slice(1).map(band)],
  };
};

/** The unit price a `unit` pricing states, or `null` for a banded one. */
export const unitPriceOf = (pricing: Pricing): UnitPrice | null =>
  pricing._tag === "unit" ? pricing.unitPrice : null;

/** A pricing as a provider config or a declaration may state it. */
export type PricingValue = Pricing | UnitPrice | PricingInput;

/**
 * Read a pricing written in any of the three forms the catalog and the vendor
 * configs accept: a normalized `Pricing`, the one-rate `UnitPrice` shorthand,
 * or the authoring `PricingInput`. Pure, so a deploy maps a price the same way
 * every time.
 */
export const asPricing = (value: PricingValue): Pricing => {
  if ("_tag" in value) return value;
  if ("kind" in value) return pricing(value);
  return { _tag: "unit", unitPrice: value };
};

const DECIMAL_PLACES = 12n;
const DECIMAL_SCALE = 10n ** DECIMAL_PLACES;

/**
 * The amount one feature unit costs, as a decimal string in minor units. A
 * package price (`$5 per 1,000`) becomes `"0.5"` cents per unit, which is how a
 * vendor that prices one unit at a time can state the same package. Rounded to
 * twelve places, the most the vendor APIs accept.
 */
export const unitAmountDecimalOf = (price: UnitPrice): string => {
  // A price read back from a vendor may already be the per-unit decimal (a
  // package's fractional rate), not the catalog's integer amount.
  if (!Number.isSafeInteger(price.amount)) return String(price.amount);
  const units = BigInt(unitsOf(price));
  if (units === 1n) return String(price.amount);
  const numerator = BigInt(price.amount) * DECIMAL_SCALE;
  const rounded = (numerator + units / 2n) / units;
  const whole = rounded / DECIMAL_SCALE;
  const fraction = (rounded % DECIMAL_SCALE).toString().padStart(Number(DECIMAL_PLACES), "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length === 0 ? String(whole) : `${whole}.${trimmed}`;
};

/** The currency a pricing bills in. */
export const currencyOfPricing = (pricing: Pricing): string =>
  pricing._tag === "unit" ? pricing.unitPrice.currency : pricing.currency;

/** Every distinct unit price a pricing can charge, in declaration order. */
export const pricesOf = (pricing: Pricing): ReadonlyArray<UnitPrice> =>
  pricing._tag === "unit" ? [pricing.unitPrice] : pricing.bands.map((band) => band.unitPrice);

/** The units one price buys, defaulting to one. */
export const unitsOf = (price: UnitPrice): number => price.units ?? 1;

/**
 * The money `units` units cost at one price: whole packages, rounded up, so a
 * partial package is still a package. `$5 per 1,000` and 1 unit is one
 * package, not half a cent; 1,500 units is two packages, which is the same
 * rounding a vendor's `divide_by` transform applies.
 */
export const priceOfUnits = (price: UnitPrice, units: number): number => {
  if (units <= 0) return 0;
  return Math.ceil(units / unitsOf(price)) * price.amount;
};

const bandCeiling = (band: PriceBand): number => (band.upTo === "inf" ? Infinity : band.upTo);

/**
 * The money `billable` units cost under a pricing, as a cumulative total.
 * Every charge is a difference of this function, so the order usage arrives in
 * cannot change the period's bill.
 */
export const priceOf = (pricing: Pricing, billable: number): number => {
  if (billable <= 0) return 0;
  if (pricing._tag === "unit") return priceOfUnits(pricing.unitPrice, billable);
  if (pricing._tag === "volume") {
    const chosen = pricing.bands.find((band) => billable <= bandCeiling(band));
    return chosen === undefined ? 0 : priceOfUnits(chosen.unitPrice, billable);
  }
  let previous = 0;
  let total = 0;
  for (const band of pricing.bands) {
    const ceiling = bandCeiling(band);
    const inBand = Math.max(0, Math.min(billable, ceiling) - previous);
    total += priceOfUnits(band.unitPrice, inBand);
    previous = ceiling;
    if (billable <= ceiling) break;
  }
  return total;
};

/** One priced line: what a band charged, and for how many units. */
export const PricedLine = Schema.Struct({
  /** The price's identity, so a replay and a report name the same rate. */
  key: Schema.String,
  unitPrice: UnitPrice,
  /** The units this line covers. */
  quantity: Schema.Int,
  /** The money this line charged, in minor units. */
  amount: Schema.Int,
});
export type PricedLine = typeof PricedLine.Type;

/**
 * Split the money between `before` and `after` billable units into the lines a
 * report and a read model carry. The sum of `amount` is the charge; the sum of
 * `quantity` is `after - before`. A band that charged nothing — because it was
 * already full — is not a line.
 */
export const pricedLines = (
  pricing: Pricing,
  before: number,
  after: number,
): ReadonlyArray<PricedLine> => {
  if (after <= before) return [];
  const from = Math.max(0, before);
  const to = Math.max(0, after);
  if (pricing._tag === "unit") {
    return [
      {
        key: priceKey(pricing.unitPrice),
        unitPrice: pricing.unitPrice,
        quantity: to - from,
        amount: priceOfUnits(pricing.unitPrice, to) - priceOfUnits(pricing.unitPrice, from),
      },
    ];
  }
  if (pricing._tag === "volume") {
    const chosen = pricing.bands.find((band) => to <= bandCeiling(band));
    if (chosen === undefined) return [];
    const amount = priceOfUnits(chosen.unitPrice, to) - priceOfUnits(chosen.unitPrice, from);
    return amount === 0
      ? []
      : [
          {
            key: priceKey(chosen.unitPrice),
            unitPrice: chosen.unitPrice,
            quantity: to - from,
            amount,
          },
        ];
  }
  const lines: Array<PricedLine> = [];
  let previous = 0;
  for (const band of pricing.bands) {
    const ceiling = bandCeiling(band);
    const bandFrom = Math.max(from, previous);
    const bandTo = Math.min(to, ceiling);
    if (bandTo > bandFrom) {
      const amount =
        priceOfUnits(band.unitPrice, bandTo - previous) -
        priceOfUnits(band.unitPrice, bandFrom - previous);
      if (amount !== 0) {
        lines.push({
          key: priceKey(band.unitPrice),
          unitPrice: band.unitPrice,
          quantity: bandTo - bandFrom,
          amount,
        });
      }
    }
    previous = ceiling;
    if (to <= ceiling) break;
  }
  return lines;
};

/** The money one event bills: the cumulative price after it minus before it. */
export const chargeOfPricing = (pricing: Pricing, before: number, after: number): number =>
  priceOf(pricing, after) - priceOf(pricing, before);

/**
 * The unit price a pricing states when it has exactly one, or `null` for a
 * banded one. A report that can only name one price uses this; a report that
 * can name a line per price uses {@link pricedLines}.
 */
export const soleUnitPriceOf = (pricing: Pricing): UnitPrice | null => {
  const prices = pricesOf(pricing);
  return prices.length === 1 ? prices[0]! : null;
};
