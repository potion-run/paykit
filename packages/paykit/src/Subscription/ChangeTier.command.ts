import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { Proration as ProrationValue } from "../Proration.ts";
import { CreditsExpire, Price, TopUpThreshold } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/**
 * A tier change would leave a blocking allowance below what is already used, so
 * every later request would be refused. A billed or allowed allowance is not
 * refused: being past `included` is the state those overages exist for.
 */
export class DowngradeBelowUsage extends Domain.Rejection("DowngradeBelowUsage", {
  feature: Schema.String,
  /** The new tier's included amount, which the usage would exceed. */
  included: Schema.Int,
  used: Schema.Int,
  /**
   * Units open holds still owe this period. `used + reserved` is what the new
   * tier has to cover; absent when nothing is held.
   */
  reserved: Schema.optionalKey(Schema.Int),
}) {}

/**
 * A tier change would put money past the ceiling the account has already spent
 * this period. `billed` is kept across a change, so a lowering cap below it
 * leaves a standing where every later `TrackUsage` is refused with
 * `MoneyCapExceeded` — a state no command can leave until the period closes.
 */
export class DowngradeBelowSpend extends Domain.Rejection("DowngradeBelowSpend", {
  feature: Schema.String,
  /** The new tier's money ceiling for this feature, in minor units. */
  moneyCap: Schema.Int,
  /** What this period has already billed. */
  billed: Schema.Int,
}) {}

/**
 * A tier change would put units past the spend ceiling the account has already
 * reached: `included + cap`, counted with the units open holds still owe.
 */
export class DowngradeBelowCeiling extends Domain.Rejection("DowngradeBelowCeiling", {
  feature: Schema.String,
  /** The new tier's ceiling: `included + cap`. */
  ceiling: Schema.Int,
  used: Schema.Int,
  /** Held by open holds, which are owed too. */
  reserved: Schema.optionalKey(Schema.Int),
}) {}

/** The account is now on another tier; the prices it moved between, and any proration. */
export class TierChanged extends Domain.Event("TierChanged", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  /**
   * The balance this change leaves in place. A tier change does not re-grant,
   * so it is the balance the account already had.
   */
  credits: Schema.Int,
  /** The part of the pool a one-off pack bought, which a change carries over. */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /** The new tier's expiry rule for the pool. */
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpThreshold),
  /** The new tier's rate cards, so `check` prices from the standing. */
  rates: CreditRateCards,
  currency: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Literals(["month", "annual"])),
  /** What the account was paying before the change. Absent from a free tier. */
  priceBefore: Schema.optionalKey(Price),
  /** What the account pays from the change on. Absent when the new tier is free. */
  priceAfter: Schema.optionalKey(Price),
  proration: Schema.optionalKey(ProrationValue),
}) {}

/** Move an existing standing to another tier. */
export class ChangeTier extends Domain.Command("ChangeTier", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    /** What the new tier grants; carrying the balance over means it is not re-granted. */
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpThreshold),
    rates: CreditRateCards,
    proration: Schema.optionalKey(ProrationValue),
  },
  events: [TierChanged],
  rejects: [
    TierNotInCatalog,
    NotSubscribed,
    CurrencyMismatch,
    DowngradeBelowUsage,
    DowngradeBelowSpend,
    DowngradeBelowCeiling,
    CatalogMismatch,
    ProrationMismatch,
  ],
  middleware: [Session, CatalogGuard],
}) {}
