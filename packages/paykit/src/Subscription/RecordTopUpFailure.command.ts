import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { Price } from "../Tier.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * An auto top-up could not be bought. Nothing was charged and nothing was
 * granted: the pool is exactly where the crossing left it.
 *
 * It is deliberately not a `PaymentFailed`: that event moves a standing into
 * grace, because it means the account owes money. A failed refill means the
 * opposite — the account was never charged — so the standing does not move
 * (ADR 0027).
 */
export class TopUpFailed extends Domain.Event("TopUpFailed", {
  /** The `kind: "one_off"` pack the tier's line named. */
  tier: Schema.String,
  /** What the pack would have cost, so an operator can see what was not collected. */
  price: Schema.optionalKey(Price),
  /** The provider that refused, or `"none"` when the account had no provider. */
  provider: Schema.String,
  /**
   * What refused, as the error's tag: `PaymentDeclined` for a card, the
   * transport's tag for a request that never landed. It is a string rather than
   * a schema union because the refusals a provider can answer are the
   * provider's, and pinning them here would refuse a deployment's own error.
   */
  reason: Schema.String,
  /** When the crossing gave up. */
  at: Schema.DateTimeUtc,
  /**
   * Which attempt this was, counting the crossing's own: `1` is the first
   * failure of the episode. It is what a scheduled retry compares itself to, so
   * a success or a newer failure makes an old deadline a no-op (ADR 0031).
   */
  attempt: Schema.Int,
  /** The crossing that failed, so an operator can tie it to the spend. */
  commandId: Schema.String,
}) {}

/**
 * Record that a crossing could not buy its pack.
 *
 * Sent by the auto top-up policy when the provider call fails, keyed by the
 * crossing, so a redelivered spend records one failure rather than one per
 * attempt. No rejection: a policy that lost a race with a purchase that
 * succeeded is `AlreadyExecuted`, which the policy treats as done.
 */
export class RecordTopUpFailure extends Domain.Command("RecordTopUpFailure", {
  target: AccountId,
  input: {
    /** The pack the line named when the crossing failed. */
    tier: Schema.String,
    /** What the pack would have cost. */
    price: Schema.optionalKey(Price),
    /** The provider that refused, or `"none"`. */
    provider: Schema.String,
    /** The refusal's tag. */
    reason: Schema.String,
  },
  events: [TopUpFailed],
  rejects: [],
  middleware: [Admin],
}) {}
