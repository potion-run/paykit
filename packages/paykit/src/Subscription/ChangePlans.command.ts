import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, PlanVersion, Price, TopUpTerms } from "../Tier.ts";
import { AlreadyCanceled } from "./AlreadyCanceled.rejection.ts";
import { GroupCancellationScheduled, GroupCancellationWithdrawn } from "./CancelGroup.command.ts";
import { DefaultPlanNotCancelable, PlanGroupEmpty } from "./CancelGroup.command.ts";
import {
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
  PlanChanged,
} from "./ChangeTier.command.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PlanCancellationRequest } from "./PlanCancellation.ts";
import { PlanGroupOccupied } from "./PlanGroupOccupied.rejection.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { PlanPhaseAtSameInstant } from "./PlanPhaseAtSameInstant.rejection.ts";
import { PlanPhaseNamesAddOn } from "./PlanPhaseNamesAddOn.rejection.ts";
import { PlanPhaseNotFuture } from "./PlanPhaseNotFuture.rejection.ts";
import { PlanVersionStale } from "./PlanVersionStale.rejection.ts";
import { PlanChangeScheduled } from "./ScheduleTierChange.command.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * One plan move inside a multi-plan operation. The terms are the catalog's,
 * frozen onto the command the same way a single `ChangeTier` or
 * `ScheduleTierChange` freezes them; `at` present means the move is a phase,
 * and absent means it takes effect now (ADR 0039 §8).
 */
export const PlanMove = Schema.Struct({
  tier: Schema.String,
  /** The catalog generation of the plan's terms this move buys (ADR 0047). */
  version: Schema.optionalKey(PlanVersion),
  /** The group the plan fills; absent means the default group. */
  group: Schema.optionalKey(Schema.String),
  /** Whether the plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
  allowances: Allowances,
  price: Schema.optionalKey(Price),
  credits: Schema.Int,
  creditsExpire: CreditsExpire,
  topUp: Schema.optionalKey(TopUpTerms),
  rates: CreditRateCards,
  /** When the move starts. Present schedules a phase; absent moves now. */
  at: Schema.optionalKey(Schema.DateTimeUtc),
});

export type PlanMove = typeof PlanMove.Type;

/**
 * Change several plans in one transaction: several groups at once, an add-on
 * beside a move, or a move and one or more future phases. The whole list is
 * validated against the standing as it was before the command, and one refusal
 * refuses every move (ADR 0039 §8).
 *
 * The command is one aggregate write, so every event it emits carries the same
 * command id through the log: a retry of the operation replays all of it or
 * none of it. A move with `at` past the clock is a `PlanChangeScheduled`; a
 * move without one is a `PlanChanged` recorded in the same transaction.
 */
export class ChangePlans extends Domain.Command("ChangePlans", {
  target: AccountId,
  input: {
    moves: Schema.Array(PlanMove),
    /** Groups to cancel at their boundary, all in the same transaction. */
    cancels: Schema.optionalKey(Schema.Array(PlanCancellationRequest)),
    /** Groups whose pending cancellation to clear in the same transaction. */
    uncancels: Schema.optionalKey(Schema.Array(Schema.String)),
  },
  events: [
    PlanChanged,
    PlanChangeScheduled,
    GroupCancellationScheduled,
    GroupCancellationWithdrawn,
  ],
  rejects: [
    NotSubscribed,
    StandingEnded,
    PlanNotInCatalog,
    PlanGroupOccupied,
    AlreadyCanceled,
    DefaultPlanNotCancelable,
    PlanGroupEmpty,
    NotScheduled,
    PlanPhaseNotFuture,
    PlanPhaseAtSameInstant,
    PlanPhaseNamesAddOn,
    CurrencyMismatch,
    DowngradeBelowUsage,
    DowngradeBelowSpend,
    DowngradeBelowCeiling,
    CatalogMismatch,
    PlanVersionStale,
  ],
  middleware: [Session, CatalogGuard],
}) {}
