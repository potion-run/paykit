import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Price, TopUpThreshold } from "../Tier.ts";
import { AlreadySubscribed } from "./AlreadySubscribed.rejection.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/** The account's standing was activated for a tier, with a fresh period. */
export class SubscriptionActivated extends Domain.Event("SubscriptionActivated", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  /** The credit pool this activation grants. */
  credits: Schema.Int,
  /**
   * The part of the pool a one-off pack already bought, carried across the
   * activation. Absent when it is zero.
   */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /** Whether that pool expires at a period close or is kept. */
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpThreshold),
  /** Every credit-priced feature's rate card, so `check` can price a request. */
  rates: CreditRateCards,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  anchorTz: Schema.String,
  interval: Schema.Literals(["month", "annual"]),
  currency: Schema.optionalKey(Schema.String),
  /** What this account was sold at. The log answers the invoice, not the catalog. */
  price: Schema.optionalKey(Price),
  statusAfter: Schema.Literal("active"),
}) {}

/** Activate a standing for a tier. Provider checkout owns the money side. */
export class Subscribe extends Domain.Command("Subscribe", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    /** What the tier grants in credits, and when they expire. */
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpThreshold),
    rates: CreditRateCards,
    anchorTz: Schema.optionalKey(Schema.String),
  },
  events: [SubscriptionActivated],
  rejects: [TierNotInCatalog, CurrencyMismatch, CatalogMismatch, AlreadySubscribed],
  middleware: [Session, CatalogGuard],
}) {}
