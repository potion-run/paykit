import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Price, TopUpThreshold } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { PendingTier } from "./Subscription.state.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/** The standing will move to `tier` at the close of the current period. */
export class TierChangeScheduled extends Domain.Event("TierChangeScheduled", PendingTier.fields) {}

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
 * them: a schedule that grants no allowance is not a tier (`TierNotInCatalog`,
 * which is what an attempt to schedule a one-off pack is), and a price in
 * another currency than the standing's is `CurrencyMismatch`. The close applies
 * the schedule from the log alone, so a wrong payload would be a wrong standing
 * at the boundary — and `credits` on it becomes the pool.
 */
export class ScheduleTierChange extends Domain.Command("ScheduleTierChange", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    topUp: Schema.optionalKey(TopUpThreshold),
    rates: CreditRateCards,
  },
  events: [TierChangeScheduled],
  rejects: [NotSubscribed, StandingEnded, TierNotInCatalog, CurrencyMismatch, CatalogMismatch],
  middleware: [Session, CatalogGuard],
}) {}
