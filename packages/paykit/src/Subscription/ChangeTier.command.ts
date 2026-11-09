import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { EntityId } from "../Customer.ts";
import { CreditRateCards } from "../Feature.ts";
import { Proration as ProrationValue } from "../Proration.ts";
import { CreditsExpire, Price, TopUpTerms } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityUnknown } from "./EntityUnknown.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { PooledItemOnEntity } from "./PooledItemOnEntity.rejection.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

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
export class PlanChanged extends Domain.Event("PlanChanged", {
  tier: Schema.String,
  /**
   * The group this plan fills. Absent means the default group, which is also
   * what an event recorded before plan groups existed decodes to.
   */
  group: Schema.optionalKey(Schema.String),
  /** Whether this plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  /**
   * The balance this change leaves in place. A tier change does not re-grant,
   * so it is the balance the account already had.
   */
  credits: Schema.Int,
  /** The part of the pool a one-off pack bought, which a change carries over. */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /**
   * The pool this plan grants when it is the plan a boundary lands on. The
   * change itself does not re-grant, so `credits` is the live pool and this is
   * what the plan promises for the next period.
   */
  planCredits: Schema.optionalKey(Schema.Int),
  /**
   * Whether this move supersedes the phases its group still had waiting. An
   * explicit move does; a phase the boundary applied does not (ADR 0039 §5–6).
   */
  supersedesSchedule: Schema.optionalKey(Schema.Boolean),
  /** The new tier's expiry rule for the pool. */
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  /** The new tier's rate cards, so `check` prices from the standing. */
  rates: CreditRateCards,
  /** The next boundary of every allowance that runs on its own schedule. */
  resetAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.DateTimeUtc)),
  currency: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Literals(["month", "annual"])),
  /** What the account was paying before the change. Absent from a free tier. */
  priceBefore: Schema.optionalKey(Price),
  /** What the account pays from the change on. Absent when the new tier is free. */
  priceAfter: Schema.optionalKey(Price),
  proration: Schema.optionalKey(ProrationValue),
  /** The entity scope the plan set belongs to; absent means the customer. */
  entity: Schema.optionalKey(EntityId),
}) {}

/** Move an existing standing to another tier. */
export class ChangeTier extends Domain.Command("ChangeTier", {
  target: AccountId,
  input: {
    tier: Schema.String,
    /** The group the plan fills; absent means the default group (ADR 0039 §1). */
    group: Schema.optionalKey(Schema.String),
    /** Whether the plan is an add-on rather than a group's plan. */
    addOn: Schema.optionalKey(Schema.Boolean),
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    /** What the new tier grants; carrying the balance over means it is not re-granted. */
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpTerms),
    rates: CreditRateCards,
    proration: Schema.optionalKey(ProrationValue),
    /** The entity scope to move; absent means the customer (ADR 0040 §3). */
    entity: Schema.optionalKey(EntityId),
  },
  events: [PlanChanged],
  rejects: [
    PlanNotInCatalog,
    NotSubscribed,
    StandingEnded,
    CurrencyMismatch,
    DowngradeBelowUsage,
    DowngradeBelowSpend,
    DowngradeBelowCeiling,
    CatalogMismatch,
    ProrationMismatch,
    EntityUnknown,
    EntityArchived,
    PooledItemOnEntity,
  ],
  middleware: [Session, CatalogGuard],
}) {}
