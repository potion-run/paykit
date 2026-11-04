import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { Price } from "../Tier.ts";
import { AccountId } from "./Subscription.id.ts";
import type { SubscriptionStatus } from "./Subscription.state.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";
import { TrialAlreadyUsed } from "./TrialAlreadyUsed.rejection.ts";

/** The account's trial began and its first period is open. */
export class TrialStarted extends Domain.Event("TrialStarted", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.Int),
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  anchorTz: Schema.String,
  trialEndsAt: Schema.DateTimeUtc,
  /** What the tier will cost when the trial converts. Absent on a free tier. */
  price: Schema.optionalKey(Price),
  statusAfter: Schema.Literal("trialing"),
}) {}

/** Begin the one trial an account may ever have. */
export class StartTrial extends Domain.Command("StartTrial", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    trialEndsAt: Schema.DateTimeUtc,
    anchorTz: Schema.optionalKey(Schema.String),
    price: Schema.optionalKey(Price),
  },
  events: [TrialStarted],
  rejects: [TrialAlreadyUsed, TierNotInCatalog, CatalogMismatch],
  middleware: [Session, CatalogGuard],
}) {}

export type TrialStartedStatus = Extract<SubscriptionStatus, "trialing">;
