import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Price, TopUpTerms } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import type { SubscriptionStatus } from "./Subscription.state.ts";
import { TrialAlreadyUsed } from "./TrialAlreadyUsed.rejection.ts";
import { TrialDeadlineNotLater } from "./TrialDeadlineNotLater.rejection.ts";

/** The account's trial began and its first period is open. */
export class TrialStarted extends Domain.Event("TrialStarted", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  /** The credit pool this trial grants. */
  credits: Schema.Int,
  /** The part of the pool a one-off pack already bought; absent when zero. */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  rates: CreditRateCards,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  anchorTz: Schema.String,
  trialEndsAt: Schema.DateTimeUtc,
  /** What the tier will cost when the trial converts. Absent on a free tier. */
  price: Schema.optionalKey(Price),
  /** The money the tier's postpaid units are billed in, when it has any. */
  currency: Schema.optionalKey(Schema.String),
  /** The next boundary of every allowance that runs on its own schedule. */
  resetAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.DateTimeUtc)),
  statusAfter: Schema.Literal("trialing"),
}) {}

/** Begin the one trial an account may ever have. */
export class StartTrial extends Domain.Command("StartTrial", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpTerms),
    rates: CreditRateCards,
    trialEndsAt: Schema.DateTimeUtc,
    anchorTz: Schema.optionalKey(Schema.String),
    price: Schema.optionalKey(Price),
  },
  events: [TrialStarted],
  rejects: [
    TrialAlreadyUsed,
    PlanNotInCatalog,
    CatalogMismatch,
    CurrencyMismatch,
    TrialDeadlineNotLater,
  ],
  middleware: [Session, CatalogGuard],
}) {}

export type TrialStartedStatus = Extract<SubscriptionStatus, "trialing">;
