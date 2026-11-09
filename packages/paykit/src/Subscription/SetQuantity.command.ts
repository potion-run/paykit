import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { EntityId } from "../Customer.ts";
import { Proration } from "../Proration.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityUnknown } from "./EntityUnknown.rejection.ts";
import { FeatureNotConsumable } from "./FeatureNotConsumable.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { StandingBlocksUsage } from "./TrackUsage.command.ts";

/** A quantity cannot be negative. */
export class QuantityInvalid extends Domain.Rejection("QuantityInvalid", {
  feature: Schema.String,
  quantity: Schema.Int,
}) {}

/** The quantity would pass the allowance's cap. */
export class QuantityCapExceeded extends Domain.Rejection("QuantityCapExceeded", {
  feature: Schema.String,
  /** The most the allowance permits. */
  cap: Schema.Int,
  /** What the caller asked for. */
  quantity: Schema.Int,
}) {}

/**
 * The allowance blocks past its included quantity, and the request is past it.
 * Like a spend cap, this is the account running out of what it bought, not a
 * standing change.
 */
export class QuantityExceeded extends Domain.Rejection("QuantityExceeded", {
  feature: Schema.String,
  /** The free quantity the allowance includes. */
  included: Schema.Int,
  /** What the caller asked for. */
  quantity: Schema.Int,
}) {}

/**
 * The quantity an account holds of one feature changed. The event carries the
 * money the change moved — `null` when the change is billed at the boundary —
 * and the id of the pending charge, so a retry is the same charge.
 */
export class QuantityChanged extends Domain.Event("QuantityChanged", {
  feature: Schema.String,
  quantityBefore: Schema.Int,
  quantityAfter: Schema.Int,
  /** What the change costs for the rest of the period. Absent for `period_end`. */
  proration: Schema.optionalKey(Proration),
  /** The key `ChargeQuantityProration` uses; the command's `dedupeKey`. */
  prorationId: Schema.optionalKey(Schema.String),
  /** The entity scope that bought; absent means the customer (ADR 0040 §3). */
  entity: Schema.optionalKey(EntityId),
}) {}

/**
 * The retry key already owns a quantity change. A key is one change: a retry
 * with the same quantity records nothing, and a different quantity under the
 * same key is refused rather than replacing the change or erasing its invoice.
 * A new quantity takes a new key.
 */
export class QuantityProrationAlreadyBilled extends Domain.Rejection(
  "QuantityProrationAlreadyBilled",
  {
    account: Schema.String,
    feature: Schema.String,
    prorationId: Schema.String,
    /** The change's `due`, so the caller can see what the key already owns. */
    due: Schema.Int,
    /** The invoice the existing change was billed on, when it has one. */
    invoiceId: Schema.optionalKey(Schema.String),
  },
) {}

/**
 * Set a non-consumable feature's quantity. A seat is bought, not spent: the
 * command sets the total the account holds, and the difference from what it
 * held is prorated for the rest of the period unless the allowance says
 * `prorate: "period_end"`.
 *
 * A quantity change is a write with money attached, so the `dedupeKey` is
 * required and doubles as the proration id. A retry records one change; a
 * second call with the same key and a different quantity is refused, because
 * the key already owns that change and possibly its invoice.
 */
export class SetQuantity extends Domain.Command("SetQuantity", {
  target: AccountId,
  input: {
    feature: Schema.String,
    /** The total quantity to hold, including the free grant. */
    quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    /** The retry key, which is also the proration id. */
    dedupeKey: Schema.String,
    /** The entity scope to set; absent means the customer (ADR 0040 §3). */
    entity: Schema.optionalKey(EntityId),
  },
  events: [QuantityChanged],
  rejects: [
    NotSubscribed,
    FeatureNotConsumable,
    QuantityInvalid,
    QuantityCapExceeded,
    QuantityExceeded,
    QuantityProrationAlreadyBilled,
    StandingBlocksUsage,
    EntityUnknown,
    EntityArchived,
    Unauthenticated,
    Forbidden,
  ],
  reply: {
    quantityAfter: Schema.Int,
    proration: Schema.optionalKey(Proration),
  },
  middleware: [Session],
}) {}
