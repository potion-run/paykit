import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { Allowance } from "./Allowance.ts";
import { RateCard } from "./Feature.ts";

/** A tier's stable id: `free`, `pro`, `scale`. */
export const TierId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("TierId"),
);

export type TierId = typeof TierId.Type;

/** The billing cadence a tier is sold on. */
export const Interval = Schema.Literals(["month", "annual"]);

export type Interval = typeof Interval.Type;

/** One currency's amount for a price, alongside the base currency. */
export const AdditionalCurrency = Schema.Struct({
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export type AdditionalCurrency = typeof AdditionalCurrency.Type;

/** Money is integer minor units plus a currency. No floats, no dollars. */
export const Price = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  interval: Interval,
  /**
   * The same plan sold in other currencies, each amount stated explicitly.
   * No exchange rate is applied: a catalog that wants to sell in EUR says so.
   */
  additionalCurrencies: Schema.optionalKey(Schema.Array(AdditionalCurrency)),
});

export type Price = typeof Price.Type;

/**
 * Whether two resolved prices state the same deal: amount, currency and
 * cadence. The additional-currency table is a catalog convenience, not part of
 * a price that has already been resolved.
 */
export const samePrice = (left: Price | undefined, right: Price | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.amount === right.amount &&
      left.currency === right.currency &&
      left.interval === right.interval;

/**
 * A price in the currency a caller asks for, or `null` when the tier does not
 * sell in it. The base currency is always available; an additional one only
 * when the catalog states it.
 */
export const priceFor = (price: Price, currency: string): Price | null => {
  if (price.currency === currency) {
    return { amount: price.amount, currency: price.currency, interval: price.interval };
  }

  const additional = price.additionalCurrencies?.find((entry) => entry.currency === currency);

  return additional === undefined
    ? null
    : { amount: additional.amount, currency: additional.currency, interval: price.interval };
};

/** When the credits a tier grants run out. `"period"` zeroes them at a close. */
export const CreditsExpire = Schema.Literals(["period", "never"]);

export type CreditsExpire = typeof CreditsExpire.Type;

/**
 * Credits at or below which a spend buys an auto top-up pack. It is a line on
 * the tier, not a price: the pack is the product, and this is when a plan's
 * pool should be refilled.
 */
export const TopUpThreshold = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export type TopUpThreshold = typeof TopUpThreshold.Type;

/**
 * The id of the `kind: "one_off"` pack a tier's line buys, as the catalog
 * names it. It is a plain string rather than a branded `TierId` because the
 * catalog is what resolves it, and a brand at this boundary would buy nothing
 * and cost every variant author a cast.
 */
export const TopUpPackId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

export type TopUpPackId = typeof TopUpPackId.Type;

/**
 * A budget for refills a provider would not collect: `attempts` retries after
 * the first attempt, each `every` after the failure it follows.
 */
export const TopUpRetry = Schema.Struct({
  /** Retries after the first attempt. `3` is four provider calls at most. */
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The wait before each retry, measured from the failure it follows. */
  every: Schema.Duration,
});

export type TopUpRetry = typeof TopUpRetry.Type;

/**
 * A tier's whole auto top-up line: when to refill, how often, and with what.
 *
 * They travel together because they are one sentence — "refill below 5,000
 * credits from the 100k pack, at most hourly, three times if it fails" — and a
 * deployment that could state one without the others would refill an enterprise
 * pool with a free tier's pack.
 */
export const TopUpTerms = Schema.Struct({
  /** Credits at or below which a spend on this tier is a crossing. */
  threshold: TopUpThreshold,
  /**
   * The shortest time between two purchases on this tier. Absent, the line is
   * the deployment's `Paykit.autoTopUp({ cooldown })`, and absent there too,
   * each crossing buys.
   */
  cooldown: Schema.optionalKey(Schema.Duration),
  /**
   * The `kind: "one_off"` pack this tier buys. Absent, the tier buys the pack
   * the deployment named as its default.
   */
  pack: Schema.optionalKey(TopUpPackId),
  /**
   * How many times a failed refill is tried again, and how long to wait. Absent,
   * a failure is recorded and left alone (ADR 0031).
   */
  retry: Schema.optionalKey(TopUpRetry),
});

export type TopUpTerms = typeof TopUpTerms.Type;

/**
 * A tier's auto top-up line as an author writes it: the same shape as
 * {@link TopUpTerms}, with the pack named by a plain string the catalog
 * resolves.
 */
export interface TopUpTermsInput {
  /** Credits at or below which a spend on this tier is a crossing. */
  readonly threshold: number;
  /** The shortest time between two purchases on this tier. */
  readonly cooldown?: Duration.Duration;
  /** The `kind: "one_off"` pack this tier buys, by id. */
  readonly pack?: string;
  /** How many times a failed refill is retried, and how long to wait. */
  readonly retry?: {
    readonly attempts: number;
    readonly every: Duration.Duration;
  };
}

/**
 * A stable key for everything a top-up line says, so the guard can tell one
 * line from another without comparing object identity. Written field by field
 * rather than through `JSON.stringify` on the value, so a `Duration` is
 * compared as its millis and cannot be spelled two ways.
 */
export const topUpKey = (terms: TopUpTerms | undefined): string =>
  terms === undefined
    ? "none"
    : JSON.stringify([
        String(terms.threshold),
        terms.cooldown === undefined ? "none" : String(Duration.toMillis(terms.cooldown)),
        terms.pack ?? "none",
      ]);

/**
 * How a tier is bought: a subscription opens a period, while a one-off pack is
 * a single payment that grants credits and never starts a period.
 */
export const TierKind = Schema.Literals(["subscription", "one_off"]);

export type TierKind = typeof TierKind.Type;

/** What a variant may change about its base tier. */
export const TierCustomize = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  price: Schema.optionalKey(Price),
  credits: Schema.optionalKey(Schema.Int),
  creditsExpire: Schema.optionalKey(CreditsExpire),
  /** Replaces the base tier's whole line; a withdrawn line is `topUp: undefined` on the base. */
  topUp: Schema.optionalKey(TopUpTerms),
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  rateCard: Schema.optionalKey(Schema.Record(Schema.String, RateCard)),
});

export type TierCustomize = typeof TierCustomize.Type;

/** An optional trial a plan offers when it is attached. */
export const PlanTrial = Schema.Struct({
  /** How long the trial lasts. Absent means the plan's own interval. */
  days: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /** Whether a payment method is required before the trial starts. */
  cardRequired: Schema.optionalKey(Schema.Boolean),
  /** What happens when the trial ends. */
  onEnd: Schema.optionalKey(Schema.Literals(["bill", "revert"])),
});

export type PlanTrial = typeof PlanTrial.Type;

/**
 * A purchasable bundle: an id, what it grants, and optionally what it costs.
 * The catalog never carries provider ids, so the same tier runs on every
 * provider.
 */
export const Tier = Schema.Struct({
  id: TierId,
  name: Schema.optionalKey(Schema.String),
  /** The plan group a move replaces within. Absent means the default group. */
  group: Schema.optionalKey(Schema.String),
  /** Whether this plan stacks alongside the current plan instead of replacing it. */
  addOn: Schema.optionalKey(Schema.Boolean),
  /** Whether this is the plan an account gets when it has none. */
  isDefault: Schema.optionalKey(Schema.Boolean),
  /** A trial the plan offers when it is attached. */
  trial: Schema.optionalKey(PlanTrial),
  /** @default "subscription" */
  kind: Schema.optionalKey(TierKind),
  price: Schema.optionalKey(Price),
  /** The credit pool this tier grants when it activates or is bought. */
  credits: Schema.optionalKey(Schema.Int),
  /** @default "period" for a subscription, "never" for a one-off pack */
  creditsExpire: Schema.optionalKey(CreditsExpire),
  /**
   * When this tier refills, how often, and with which pack. Absent means this
   * tier never refills; a one-off pack cannot state one.
   */
  topUp: Schema.optionalKey(TopUpTerms),
  grants: Schema.Array(Allowance),
  /**
   * Whether a customer may hold bespoke allowances under this plan. Absent
   * means the plan is fixed: `grants` is exactly what any customer may hold
   * under it. A custom plan's `grants` are the defaults a caller gets when it
   * states none, and the shape a bespoke set is judged against (ADR 0041).
   * A custom plan may be an add-on: it is the same opt-in, stacked beside the
   * group's plan (ADR 0042 §2).
   */
  custom: Schema.optionalKey(Schema.Boolean),
  /**
   * The base tier this one is a named alternative of, e.g. annual Pro. The
   * catalog resolves the variant into a full tier, so the runtime never sees
   * a partial one.
   */
  variantOf: Schema.optionalKey(TierId),
  /** What this variant changes about its base. Requires `variantOf`. */
  customize: Schema.optionalKey(TierCustomize),
  /**
   * Per-feature rate-card overrides for this tier. A feature with no entry
   * uses the card the catalog declares for it.
   */
  rateCard: Schema.optionalKey(Schema.Record(Schema.String, RateCard)),
});

export type Tier = typeof Tier.Type;

/** A subscription tier as an author writes it: at least one grant. */
export interface SubscriptionTierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** The group a move replaces within. */
  readonly group?: string;
  /** Whether this plan stacks beside the current plan. */
  readonly addOn?: boolean;
  /** Whether this is the plan an account gets when it has none. */
  readonly isDefault?: boolean;
  /** A trial the plan offers when attached. */
  readonly trial?: PlanTrial;
  /** @default "subscription" */
  readonly kind?: "subscription";
  /** Omit for a free subscription tier. */
  readonly price?: Price;
  /** The credit pool this tier grants when it activates. */
  readonly credits?: number;
  /** @default "period" */
  readonly creditsExpire?: CreditsExpire;
  /**
   * When this tier refills, how often, and with which pack. Absent means this
   * tier never refills.
   */
  readonly topUp?: TopUpTermsInput;
  /**
   * What the tier grants. A subscription that grants nothing could never
   * activate, so the tuple requires at least one allowance.
   */
  readonly grants: readonly [Allowance, ...Allowance[]];
  /**
   * Whether a customer may hold bespoke allowances under this plan (ADR 0041).
   * It is the deployment's opt-in, so it is stated here, once, and not on a
   * request. An add-on may state it: a bespoke add-on stacks beside every
   * group just like a catalog one (ADR 0042 §2).
   */
  readonly custom?: boolean;
  /** The base tier this one is a named alternative of. */
  readonly variantOf?: string;
  /** What this variant changes about its base. Requires `variantOf`. */
  readonly customize?: TierCustomize;
  /** Per-feature rate-card overrides for this tier. */
  readonly rateCard?: Readonly<Record<string, RateCard>>;
}

/** A one-off credit pack as an author writes it: a price, credits, no grants. */
export interface OneOffTierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  readonly group?: string;
  readonly addOn?: boolean;
  readonly isDefault?: boolean;
  readonly trial?: PlanTrial;
  readonly kind: "one_off";
  /** A pack is bought, so it must state a price. */
  readonly price: Price;
  /** The credits the buyer gets. */
  readonly credits: number;
  /** A pack outlives any plan, so its credits never expire. */
  readonly creditsExpire?: "never";
  /** A pack has no standing, so it cannot state a top-up line. */
  readonly topUp?: never;
  /** A pack sells credits, not a standing, so it grants no allowance. */
  readonly grants?: readonly [];
  /** A pack has no allowances to make bespoke. */
  readonly custom?: never;
  readonly variantOf?: never;
  readonly customize?: never;
  readonly rateCard?: never;
}

/**
 * A variant as an author writes it: the fields it changes, over a base tier.
 * `grants` may be omitted, because the base's grants are inherited.
 */
export interface VariantTierInput {
  readonly id: string;
  readonly name?: string;
  readonly group?: string;
  readonly addOn?: boolean;
  readonly isDefault?: boolean;
  readonly trial?: PlanTrial;
  readonly kind?: "subscription";
  readonly price?: Price;
  readonly credits?: number;
  readonly creditsExpire?: CreditsExpire;
  readonly topUp?: TopUpTermsInput;
  readonly grants?: readonly Allowance[];
  /**
   * Inherited from the base plan, and never stated on a variant: a variant of
   * a custom plan is the same negotiated plan at another price, and a fixed
   * base cannot grow a bespoke child (ADR 0041 §5).
   */
  readonly custom?: never;
  readonly variantOf: string;
  readonly customize?: TierCustomize;
  readonly rateCard?: Readonly<Record<string, RateCard>>;
}

/** A tier as an author writes it. */
export type TierInput = SubscriptionTierInput | VariantTierInput | OneOffTierInput;

const topUpTermsOf = (input: TopUpTermsInput): TopUpTerms => ({
  threshold: input.threshold,
  ...(input.cooldown === undefined ? {} : { cooldown: input.cooldown }),
  ...(input.pack === undefined ? {} : { pack: input.pack }),
  ...(input.retry === undefined
    ? {}
    : { retry: { attempts: input.retry.attempts, every: input.retry.every } }),
});

/**
 * Declare a purchasable bundle. The catalog validates it; this stays pure.
 *
 * ### Declaring a tier
 * **Example:** A free tier and a tier sold monthly
 * ```typescript
 * const free = tier({
 *   id: "free",
 *   name: "Free",
 *   grants: [allowance(messages, { included: 100 })],
 * });
 *
 * const pro = tier({
 *   id: "pro",
 *   name: "Pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * // A one-off pack sells credits, not a period.
 * const pack = tier({
 *   id: "credits_1m",
 *   kind: "one_off",
 *   price: { amount: 9_900, currency: "usd", interval: "month" },
 *   credits: 1_000_000,
 *   grants: [],
 * });
 * ```
 */
export const tier = (input: TierInput): Tier => {
  const kind = input.kind ?? "subscription";
  // A one-off pack's credits are what the buyer bought; they must outlive any
  // plan the account happens to be on, so the default is the same `"never"`
  // the catalog requires.
  const creditsExpire = input.creditsExpire ?? (kind === "one_off" ? "never" : undefined);
  const grants = input.grants ?? [];

  // SAFETY: the catalog schema validates the id and variant when the tier is declared.
  return {
    id: input.id as TierId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.group === undefined ? {} : { group: input.group }),
    ...(input.addOn === undefined ? {} : { addOn: input.addOn }),
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.custom === undefined ? {} : { custom: input.custom }),
    ...(input.trial === undefined ? {} : { trial: input.trial }),
    ...(input.kind === undefined ? {} : { kind }),
    ...(input.price === undefined ? {} : { price: { ...input.price } }),
    ...(input.credits === undefined ? {} : { credits: input.credits }),
    ...(creditsExpire === undefined ? {} : { creditsExpire }),
    ...(input.topUp === undefined ? {} : { topUp: topUpTermsOf(input.topUp) }),
    ...(input.variantOf === undefined ? {} : { variantOf: input.variantOf as TierId }),
    ...(input.customize === undefined ? {} : { customize: input.customize }),
    ...(input.rateCard === undefined ? {} : { rateCard: { ...input.rateCard } }),
    grants: grants.map((grant) => ({ ...grant })),
  };
};
