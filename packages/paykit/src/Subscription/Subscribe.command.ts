import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Price, TopUpTerms } from "../Tier.ts";
import { AlreadySubscribed } from "./AlreadySubscribed.rejection.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The account's standing was activated for a tier, with a fresh period. */
export class SubscriptionActivated extends Domain.Event("SubscriptionActivated", {
  tier: Schema.String,
  /**
   * The group the plan fills. Absent means the default group, which is also
   * the default group an activation that names none fills (ADR 0039 §1).
   */
  group: Schema.optionalKey(Schema.String),
  /** Whether the plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
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
  topUp: Schema.optionalKey(TopUpTerms),
  /** Every credit-priced feature's rate card, so `check` can price a request. */
  rates: CreditRateCards,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  anchorTz: Schema.String,
  interval: Schema.Literals(["month", "annual"]),
  currency: Schema.optionalKey(Schema.String),
  /** What this account was sold at. The log answers the invoice, not the catalog. */
  price: Schema.optionalKey(Price),
  /** The next boundary of every allowance that runs on its own schedule. */
  resetAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.DateTimeUtc)),
  /** The provider's charge this activation was paid by, when it reported one. */
  chargeId: Schema.optionalKey(Schema.String),
  statusAfter: Schema.Literal("active"),
}) {}

/** Activate a standing for a tier. Provider checkout owns the money side. */
export class Subscribe extends Domain.Command("Subscribe", {
  target: AccountId,
  input: {
    tier: Schema.String,
    /** The group the plan fills; absent means the default group (ADR 0039 §1). */
    group: Schema.optionalKey(Schema.String),
    /** Whether the plan is an add-on rather than a group's plan. */
    addOn: Schema.optionalKey(Schema.Boolean),
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    /** What the tier grants in credits, and when they expire. */
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpTerms),
    rates: CreditRateCards,
    anchorTz: Schema.optionalKey(Schema.String),
    /** The provider's charge this activation was paid by, when it reported one. */
    chargeId: Schema.optionalKey(Schema.String),
  },
  events: [SubscriptionActivated],
  rejects: [PlanNotInCatalog, CurrencyMismatch, CatalogMismatch, AlreadySubscribed],
  middleware: [Session, CatalogGuard],
}) {}
