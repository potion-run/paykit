import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, Price } from "../Tier.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { PendingTier } from "./Subscription.state.ts";

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
 */
export class ScheduleTierChange extends Domain.Command("ScheduleTierChange", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    credits: Schema.Int,
    creditsExpire: CreditsExpire,
    rates: CreditRateCards,
  },
  events: [TierChangeScheduled],
  rejects: [NotSubscribed],
  middleware: [Session],
}) {}
