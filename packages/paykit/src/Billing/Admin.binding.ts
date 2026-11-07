import * as Binding from "alchemy/Binding";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import type { BillingStateView } from "../Subscription/BillingState.view.ts";
import { AlreadyInGrace } from "../Subscription/EnterGrace.command.ts";
import { TrialNotActive } from "../Subscription/ExtendTrial.command.ts";
import { NotInGrace } from "../Subscription/NotInGrace.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { RefundExceedsCharged } from "../Subscription/Refund.command.ts";
import type { SubscriptionStatus } from "../Subscription/Subscription.state.ts";
import { TrialDeadlineNotLater } from "../Subscription/TrialDeadlineNotLater.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * What every admin verb on a standing answers: the standing as the console reads
 * it, straight after the command. A verb whose number the log records returns it
 * as a `reply` instead (`GrantCredits` → `{ balance }`).
 */
export interface StandingSnapshot {
  readonly tier: string;
  readonly status: SubscriptionStatus;
  readonly credits: number;
  readonly dunningAttempts: number;
  readonly trialEndsAt?: DateTime.Utc;
  readonly graceUntil?: DateTime.Utc;
  readonly cancelAtPeriodEnd: boolean;
}

/** The view the admin verbs read back, as the snapshot they answer. */
export const standingSnapshot = (view: BillingStateView | null): StandingSnapshot => ({
  tier: view?.tier ?? "",
  status: view?.status ?? "expired",
  credits: view?.credits ?? 0,
  dunningAttempts: view?.dunningAttempts ?? 0,
  ...(view?.trialEndsAt === undefined ? {} : { trialEndsAt: view.trialEndsAt }),
  ...(view?.graceUntil === undefined ? {} : { graceUntil: view.graceUntil }),
  cancelAtPeriodEnd: view?.cancelAtPeriodEnd ?? false,
});

/** Grant credits to the pool. */
export interface GrantCreditsRequest {
  /** Credits to add. The command refuses a non-positive amount by recording nothing. */
  readonly amount: number;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** The pool after the grant, as the command's reply. */
export interface GrantCreditsResult {
  readonly balance: number;
}

/** Move a trial deadline forward. */
export interface ExtendTrialRequest {
  /** The new deadline. It must be after the one already in force. */
  readonly trialEndsAt: DateTime.Utc;
  readonly dedupeKey: string;
}

/** Put a standing into grace until a deadline. */
export interface EnterGraceRequest {
  readonly graceUntil: DateTime.Utc;
  readonly dedupeKey: string;
}

/** Book money that arrived. */
export interface RecordPaymentRequest {
  /** Minor units. */
  readonly amount: number;
  readonly currency: string;
  readonly dedupeKey: string;
}

/** Record a failed payment and the grace deadline it opens. */
export interface RecordPaymentFailureRequest {
  /** The provider's reason, as an operator reads it. */
  readonly reason: string;
  readonly graceUntil: DateTime.Utc;
  readonly dedupeKey: string;
}

/** Refund money that already left the customer, up to what the account was charged. */
export interface RefundRequest {
  /** The provider's reference for what is being refunded. */
  readonly chargeId: string;
  /** Minor units. A non-positive amount records nothing; too much is refused. */
  readonly amount: number;
  readonly currency: string;
  /** Why the money went back, as an operator would tell a customer. */
  readonly reason?: string;
  /** The retry key, which is also the provider's idempotency key and the command id. */
  readonly dedupeKey: string;
}

/** What a refund answers: the provider's id, and the currency's running total. */
export interface RefundResult {
  readonly refundId: string;
  /** Minor units refunded in this currency so far, as the event recorded it. */
  readonly refunded: number;
  readonly currency: string;
}

/** The verbs with nothing to say but their retry key. */
export interface AdminRequest {
  readonly dedupeKey: string;
}

const grantRefusals = [NotSubscribed, Unauthenticated, Forbidden] as const;
const extendRefusals = [
  NotSubscribed,
  TrialNotActive,
  TrialDeadlineNotLater,
  Unauthenticated,
  Forbidden,
] as const;
const graceRefusals = [
  NotSubscribed,
  AlreadyInGrace,
  NotInGrace,
  Unauthenticated,
  Forbidden,
] as const;
const recoverRefusals = [NotInGrace, Unauthenticated, Forbidden] as const;
const expireRefusals = [NotInGrace, Unauthenticated, Forbidden] as const;
const paymentRefusals = [NotInGrace, Unauthenticated, Forbidden] as const;
const refundRefusals = [
  RefundExceedsCharged,
  ProviderCapabilityMissing,
  PaymentDeclined,
  Unauthenticated,
  Forbidden,
] as const;
const paymentFailureRefusals = [Unauthenticated, Forbidden] as const;

/** Every refusal this operator command can answer. */
export type GrantCreditsRefusal = InstanceType<(typeof grantRefusals)[number]>;
export type ExtendTrialRefusal = InstanceType<(typeof extendRefusals)[number]>;
export type EnterGraceRefusal = InstanceType<(typeof graceRefusals)[number]>;
export type RecoverRefusal = InstanceType<(typeof recoverRefusals)[number]>;
export type ExpireRefusal = InstanceType<(typeof expireRefusals)[number]>;
export type RecordPaymentRefusal = InstanceType<(typeof paymentRefusals)[number]>;
export type RefundRefusal = InstanceType<(typeof refundRefusals)[number]>;
export type RecordPaymentFailureRefusal = InstanceType<(typeof paymentFailureRefusals)[number]>;

export type GrantCreditsError = BindingError<GrantCreditsRefusal>;
export type ExtendTrialError = BindingError<ExtendTrialRefusal>;
export type EnterGraceError = BindingError<EnterGraceRefusal>;
export type RecoverError = BindingError<RecoverRefusal>;
export type ExpireError = BindingError<ExpireRefusal>;
export type RecordPaymentError = BindingError<RecordPaymentRefusal>;
export type RefundError = BindingError<RefundRefusal>;
export type RecordPaymentFailureError = BindingError<RecordPaymentFailureRefusal>;

/** A layer's own failure, as each binding's declared union. */
export const toGrantCreditsError = toBindingError(
  "Paykit.GrantCredits",
  oneOf<GrantCreditsRefusal>(grantRefusals),
);
export const toExtendTrialError = toBindingError(
  "Paykit.ExtendTrial",
  oneOf<ExtendTrialRefusal>(extendRefusals),
);
export const toEnterGraceError = toBindingError(
  "Paykit.EnterGrace",
  oneOf<EnterGraceRefusal>(graceRefusals),
);
export const toRecoverError = toBindingError(
  "Paykit.Recover",
  oneOf<RecoverRefusal>(recoverRefusals),
);
export const toExpireError = toBindingError("Paykit.Expire", oneOf<ExpireRefusal>(expireRefusals));
export const toRecordPaymentError = toBindingError(
  "Paykit.RecordPayment",
  oneOf<RecordPaymentRefusal>(paymentRefusals),
);
export const toRefundError = toBindingError("Paykit.Refund", oneOf<RefundRefusal>(refundRefusals));
export const toRecordPaymentFailureError = toBindingError(
  "Paykit.RecordPaymentFailure",
  oneOf<RecordPaymentFailureRefusal>(paymentFailureRefusals),
);

/** The verb of a bound `GrantCredits`. */
export type GrantCreditsVerb = (
  request: GrantCreditsRequest,
) => Effect.Effect<GrantCreditsResult, GrantCreditsError>;
/** The verb of a bound `ExtendTrial`. */
export type ExtendTrialVerb = (
  request: ExtendTrialRequest,
) => Effect.Effect<StandingSnapshot, ExtendTrialError>;
/** The verb of a bound `EnterGrace`. */
export type EnterGraceVerb = (
  request: EnterGraceRequest,
) => Effect.Effect<StandingSnapshot, EnterGraceError>;
/** The verb of a bound `Recover`. */
export type RecoverVerb = (request: AdminRequest) => Effect.Effect<StandingSnapshot, RecoverError>;
/** The verb of a bound `Expire`. */
export type ExpireVerb = (request: AdminRequest) => Effect.Effect<StandingSnapshot, ExpireError>;
/** The verb of a bound `RecordPayment`. */
export type RecordPaymentVerb = (
  request: RecordPaymentRequest,
) => Effect.Effect<StandingSnapshot, RecordPaymentError>;
/** The verb of a bound `Refund`. */
export type RefundVerb = (request: RefundRequest) => Effect.Effect<RefundResult, RefundError>;
/** The verb of a bound `RecordPaymentFailure`. */
export type RecordPaymentFailureVerb = (
  request: RecordPaymentFailureRequest,
) => Effect.Effect<StandingSnapshot, RecordPaymentFailureError>;

/**
 * Grant credits to the pool. An operator's correction, not a purchase: a bought
 * pack is `PurchaseCredits` with an invoice, so the log can tell a gift from a
 * sale.
 *
 * ### Granting credit
 * **Example:** Add 250 credits
 * ```typescript
 * const grant = yield* Paykit.GrantCredits(account);
 * const { balance } = yield* grant({ amount: 250, dedupeKey: ticketId });
 * ```
 *
 * @binding
 * @product Credits
 * @provides Paykit.GrantCredits
 */
export interface GrantCredits extends Binding.Service<
  GrantCredits,
  "Paykit.GrantCredits",
  (account: string) => Effect.Effect<GrantCreditsVerb>
> {}

export const GrantCredits = Binding.Service<GrantCredits>("Paykit.GrantCredits");

/**
 * Move a trial's deadline forward. It only moves forward: a deadline that is not
 * after the one in force is `TrialDeadlineNotLater`, so a lagging operator cannot
 * shorten a trial by accident.
 *
 * ### Extending a trial
 * **Example:** Give a stalled trial another week
 * ```typescript
 * const extend = yield* Paykit.ExtendTrial(account);
 * yield* extend({ trialEndsAt: DateTime.add(now, { days: 7 }), dedupeKey: ticketId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.ExtendTrial
 */
export interface ExtendTrial extends Binding.Service<
  ExtendTrial,
  "Paykit.ExtendTrial",
  (account: string) => Effect.Effect<ExtendTrialVerb>
> {}

export const ExtendTrial = Binding.Service<ExtendTrial>("Paykit.ExtendTrial");

/**
 * Put a standing into grace until a deadline. Grace keeps the account working
 * while a payment is retried, and `GraceElapsed` at the deadline is what ends it.
 *
 * ### Opening grace by hand
 * **Example:** Give a failed card a week
 * ```typescript
 * const enterGrace = yield* Paykit.EnterGrace(account);
 * yield* enterGrace({ graceUntil: DateTime.add(now, { days: 7 }), dedupeKey: ticketId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.EnterGrace
 */
export interface EnterGrace extends Binding.Service<
  EnterGrace,
  "Paykit.EnterGrace",
  (account: string) => Effect.Effect<EnterGraceVerb>
> {}

export const EnterGrace = Binding.Service<EnterGrace>("Paykit.EnterGrace");

/**
 * End grace because the payment arrived. A recover outside grace has nothing to
 * end, so the model answers `NotInGrace`.
 *
 * ### Recovering an account
 * **Example:** The card went through
 * ```typescript
 * const recover = yield* Paykit.Recover(account);
 * yield* recover({ dedupeKey: paymentId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Recover
 */
export interface Recover extends Binding.Service<
  Recover,
  "Paykit.Recover",
  (account: string) => Effect.Effect<RecoverVerb>
> {}

export const Recover = Binding.Service<Recover>("Paykit.Recover");

/**
 * End the standing now, after grace has run out. Nothing in a delete path
 * cancels, refunds or deletes provider state (ADR 0003), so this records an
 * expiry and leaves the vendor's records alone.
 *
 * ### Expiring an account
 * **Example:** Grace elapsed with no payment
 * ```typescript
 * const expire = yield* Paykit.Expire(account);
 * yield* expire({ dedupeKey: graceEventId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Expire
 */
export interface Expire extends Binding.Service<
  Expire,
  "Paykit.Expire",
  (account: string) => Effect.Effect<ExpireVerb>
> {}

export const Expire = Binding.Service<Expire>("Paykit.Expire");

/**
 * Book money that arrived outside the provider's webhook: a bank transfer on a
 * manual invoice, a payment an operator reconciled by hand.
 *
 * ### Recording a transfer
 * **Example:** The manual invoice was paid
 * ```typescript
 * const recordPayment = yield* Paykit.RecordPayment(account);
 * yield* recordPayment({ amount: 1900, currency: "usd", dedupeKey: invoiceId });
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.RecordPayment
 */
export interface RecordPayment extends Binding.Service<
  RecordPayment,
  "Paykit.RecordPayment",
  (account: string) => Effect.Effect<RecordPaymentVerb>
> {}

export const RecordPayment = Binding.Service<RecordPayment>("Paykit.RecordPayment");

/**
 * Record a failed payment and the grace deadline it opens. The attempt count
 * is what a console shows and the deadline is what the sweep acts on; a
 * deployment that installs the `dunning` layer also retries the saved method
 * on its ladder before that deadline.
 *
 * ### Recording a declined card
 * **Example:** Enter grace from a declined charge
 * ```typescript
 * const failed = yield* Paykit.RecordPaymentFailure(account);
 * yield* failed({ reason: "card_declined", graceUntil: DateTime.add(now, { days: 7 }), dedupeKey: eventId });
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.RecordPaymentFailure
 */
export interface RecordPaymentFailure extends Binding.Service<
  RecordPaymentFailure,
  "Paykit.RecordPaymentFailure",
  (account: string) => Effect.Effect<RecordPaymentFailureVerb>
> {}

export const RecordPaymentFailure = Binding.Service<RecordPaymentFailure>(
  "Paykit.RecordPaymentFailure",
);

/**
 * Send money back for a charge the account already paid.
 *
 * Three rules, from [ADR 0019](../../../../docs/adr/0019-a-refund-names-the-charge-it-reverses.md):
 *
 * - **The ceiling is what the log records.** A refund cannot exceed what the
 *   account was charged in its currency, minus what already went back
 *   (`RefundExceedsCharged`). The binding checks it before it calls the
 *   provider, so a refund the model would refuse never leaves the account.
 * - **The provider takes the money, the log records it.** `Payments.refund` is
 *   keyed by `dedupeKey`, so a retry is the same refund at the vendor and the
 *   same command here; the provider's refund id is what the event carries.
 * - **A refund does not touch the pool.** Revoking credits is `ConsumeCredits`,
 *   sent separately, so "money left" and "credits were burned" stay two facts.
 *
 * It is implemented where the provider is reachable — the in-process operator
 * layer — because a console backend that owns only the Api cannot move money.
 *
 * ### Refunding a pack
 * **Example:** Send back what a charge took
 * ```typescript
 * const refund = yield* Paykit.Refund(account);
 * const { refundId, refunded } = yield* refund({
 *   chargeId: "ch_123",
 *   amount: 1900,
 *   currency: "usd",
 *   reason: "duplicate order",
 *   dedupeKey: ticketId,
 * });
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.Refund
 */
export interface Refund extends Binding.Service<
  Refund,
  "Paykit.Refund",
  (account: string) => Effect.Effect<RefundVerb>
> {}

export const Refund = Binding.Service<Refund>("Paykit.Refund");
