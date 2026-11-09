import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { CatalogGuard } from "../CatalogGuard.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { BillingControls } from "../Customer.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The catalog fact about one feature that a controls write needs. `decide` is
 * pure, so whether a feature has a postpaid price travels on the command; the
 * deploy's `CatalogGuard` checks it against the catalog it validated.
 */
export const ControlFeature = Schema.Struct({
  /** Whether some plan in the catalog bills this feature postpaid. */
  priced: Schema.Boolean,
});

export type ControlFeature = typeof ControlFeature.Type;

/** A limit or alert names a feature the catalog does not declare. */
export class ControlsFeatureUnknown extends Domain.Rejection("ControlsFeatureUnknown", {
  featureId: Schema.String,
}) {}

/** A spend limit is money, so the feature has to have a price to bill. */
export class ControlsFeatureNotPriced extends Domain.Rejection("ControlsFeatureNotPriced", {
  featureId: Schema.String,
}) {}

/**
 * One feature cannot hold two spend limits, and one `(feature, at)` pair cannot
 * be two alerts. The payload is representable and ambiguous at once, so it is a
 * tagged refusal with evidence, not a decode error outside the union.
 */
export class ControlsDuplicate extends Domain.Rejection("ControlsDuplicate", {
  list: Schema.Literals(["spendLimits", "usageAlerts"]),
  featureId: Schema.String,
  /** The threshold two alerts shared; absent for a limit. */
  at: Schema.optionalKey(Schema.Int),
}) {}

/**
 * The customer's controls, as written. It carries the whole object rather than
 * a patch, and the object is absent when every control was cleared: the last
 * write is the state, and replaying the log reproduces exactly what the
 * customer asked for at each point (ADR 0038).
 */
export class BillingControlsSet extends Domain.Event("BillingControlsSet", {
  billingControls: Schema.optionalKey(BillingControls),
}) {}

/**
 * Replace a customer's billing controls: its auto top-up line, its spend
 * ceilings and its usage alerts. It works before a plan exists, because a
 * control is customer intent that binds when a plan grants the feature; the
 * whole object is replaced on each write, and an object equal to the one in
 * force records nothing.
 *
 * A ceiling is a period control, not a standing: `TrackUsage` and `Hold` refuse
 * a charge that would pass it with `SpendLimitExceeded`, while the account's
 * standing stays `good`. An alert never refuses anything; it records
 * `UsageAlertFired` once per period and moves no counter.
 */
export class SetBillingControls extends Domain.Command("SetBillingControls", {
  target: AccountId,
  input: {
    billingControls: Schema.optionalKey(BillingControls),
    /** Keyed by feature id: one entry per feature the object names. */
    features: Schema.Record(Schema.String, ControlFeature),
  },
  events: [BillingControlsSet],
  rejects: [ControlsFeatureUnknown, ControlsFeatureNotPriced, ControlsDuplicate, CatalogMismatch],
  middleware: [Session, CatalogGuard],
}) {}
