import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { Proration as ProrationValue } from "../Proration.ts";
import { CreditsExpire, Price } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/** A tier change would leave usage above the new tier's included amount. */
export class DowngradeBelowUsage extends Domain.Rejection("DowngradeBelowUsage", {
  feature: Schema.String,
  included: Schema.Int,
  used: Schema.Int,
  /**
   * Units open holds still owe this period. `used + reserved` is what the new
   * tier has to cover; absent when nothing is held.
   */
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
    rates: CreditRateCards,
    proration: Schema.optionalKey(ProrationValue),
  },
  events: [TierChanged],
  rejects: [
    TierNotInCatalog,
    NotSubscribed,
    CurrencyMismatch,
    DowngradeBelowUsage,
    CatalogMismatch,
    ProrationMismatch,
  ],
  middleware: [Session, CatalogGuard],
}) {}
