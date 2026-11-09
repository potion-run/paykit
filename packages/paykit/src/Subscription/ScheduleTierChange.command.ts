import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Interval, Price, TopUpTerms } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { PlanPhaseNamesAddOn } from "./PlanPhaseNamesAddOn.rejection.ts";
import { PlanPhaseNotFuture } from "./PlanPhaseNotFuture.rejection.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The standing will move to `tier` at `at`, carrying the terms it needs there. */
export class PlanChangeScheduled extends Domain.Event("PlanChangeScheduled", {
  tier: Schema.String,
  /**
   * The group the phase moves. Absent means the default group.
   */
  group: Schema.optionalKey(Schema.String),
  /** Whether the plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
  allowances: Allowances,
  price: Schema.optionalKey(Price),
  /** The pool this plan grants when the phase is the plan a boundary lands on. */
  credits: Schema.Int,
  creditsExpire: CreditsExpire,
  topUp: Schema.optionalKey(TopUpTerms),
  rates: CreditRateCards,
  interval: Schema.optionalKey(Interval),
  currency: Schema.optionalKey(Schema.String),
  /** When the phase starts. The scheduler applies it at this instant. */
  at: Schema.DateTimeUtc,
}) {}

/**
 * Move to another tier when the period ends, rather than now.
 *
 * This is the boundary form of `ChangeTier`, and it is the answer to a move that
 * cannot be made mid-period: a smaller allowance than the period has already
 * used, or a ceiling it has already passed, is refused now (ADR 0009, 0011) and
 * belongs here instead. The counters reset at the same boundary, so the new tier
 * starts with a clean period rather than inheriting one it cannot cover.
 *
 * Scheduling is replaceable: a second schedule overwrites the first, and a
 * mid-period `ChangeTier` cancels it, because the account has already moved.
 *
 * The terms are the catalog's, and they are checked the way `ChangeTier` checks
 * them: a schedule that grants no allowance is not a tier (`PlanNotInCatalog`,
 * which is what an attempt to schedule a one-off pack is), and a price in
 * another currency than the standing's is `CurrencyMismatch`. The close applies
 * the schedule from the log alone, so a wrong payload would be a wrong standing
 * at the boundary — and `credits` on it becomes the pool.
 */
export class ScheduleTierChange extends Domain.Command("ScheduleTierChange", {
  target: AccountId,
  input: {
    tier: Schema.String,
    /** The group the phase moves; absent means the default group. */
    group: Schema.optionalKey(Schema.String),
    /** Whether the plan is an add-on rather than a group's plan. */
    addOn: Schema.optionalKey(Schema.Boolean),
    /**
     * When the phase starts. Absent means the close of the current period, the
     * only boundary a caller has to know about (ADR 0039 §3).
     */
    at: Schema.optionalKey(Schema.DateTimeUtc),
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpTerms),
    rates: CreditRateCards,
  },
  events: [PlanChangeScheduled],
  rejects: [
    NotSubscribed,
    StandingEnded,
    PlanNotInCatalog,
    PlanPhaseNotFuture,
    PlanPhaseNamesAddOn,
    CurrencyMismatch,
    CatalogMismatch,
  ],
  middleware: [Session, CatalogGuard],
}) {}
