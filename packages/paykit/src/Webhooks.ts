import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asSystem } from "./Auth/Actor.ts";
import { planOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import {
  PendingActivationMissing,
  PendingActivationStale,
} from "./Subscription/PendingActivation.ts";
import { PlanNotInCatalog } from "./Subscription/PlanNotInCatalog.rejection.ts";
import { PurchaseCredits } from "./Subscription/PurchaseCredits.command.ts";
import { RecordPayment } from "./Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "./Subscription/RecordPaymentFailure.command.ts";
import { ScheduleCancellation } from "./Subscription/ScheduleCancellation.command.ts";
import { standingPhaseTagOfStatus, type StandingPhaseTag } from "./Subscription/StandingPhase.ts";
import { Subscribe as SubscribeCommand } from "./Subscription/Subscribe.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "./Subscription/Subscription.state.ts";
import { purchaseCreditsInputOf, subscribeInputOf } from "./TierCommand.ts";

/** The provider events paykit translates into its own commands. */
export const WebhookKind = Schema.Literals([
  "checkout_completed",
  "payment_succeeded",
  "payment_failed",
  "subscription_canceled",
]);

export type WebhookKind = typeof WebhookKind.Type;

/**
 * A provider-neutral webhook. Adapters decode the vendor payload into this,
 * keeping vendor HTTP and signatures outside the model.
 */
export const WebhookEvent = Schema.Struct({
  /** The provider's event id. Used as the command id, so a redelivery is a replay. */
  id: Schema.String,
  provider: Schema.String,
  kind: WebhookKind,
  account: Schema.String,
  tier: Schema.optionalKey(Schema.String),
  amount: Schema.optionalKey(Schema.Int),
  currency: Schema.optionalKey(Schema.String),
  /** The provider's charge id, when the event reports one. */
  chargeId: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  graceUntil: Schema.optionalKey(Schema.DateTimeUtc),
  anchorTz: Schema.optionalKey(Schema.String),
});

export type WebhookEvent = typeof WebhookEvent.Type;

/** A webhook was missing data its kind needs. */
export class WebhookInvalid extends Schema.TaggedError<WebhookInvalid>()("WebhookInvalid", {
  event: Schema.String,
  field: Schema.String,
}) {}

/** A webhook did not come from the provider, or did not come recently. */
export class WebhookSignatureInvalid extends Schema.TaggedError<WebhookSignatureInvalid>()(
  "WebhookSignatureInvalid",
  {
    provider: Schema.String,
    reason: Schema.String,
  },
) {}

/** What a provider signs and sends: the raw body and the headers it signed. */
export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The only errors a provider's webhook translation may return. */
export type WebhookError = WebhookSignatureInvalid | WebhookInvalid;

/**
 * A provider's webhook, as the provider carries it.
 *
 * The vendor package that owns the signature and the payload also owns this
 * decoder, and hands it back on the provider it returns — so a caller wires the
 * tier mapping and the secret once, instead of once per call site.
 */
export interface PaymentsWebhook {
  /** The provider's name, the same one `refs` are keyed by. */
  readonly provider: string;
  readonly decode: (
    request: WebhookRequest,
  ) => Effect.Effect<Option.Option<WebhookEvent>, WebhookError>;
}

/** What the edge did with an event. */
export const WebhookAction = Schema.Literals([
  "activated",
  "purchased",
  "recovered",
  "failed",
  "canceled",
  "ignored",
]);

export type WebhookAction = typeof WebhookAction.Type;

/** Every phase a delivery can find a standing in. */
export const WEBHOOK_PHASES: ReadonlyArray<StandingPhaseTag> = [
  "Unsubscribed",
  "Trialing",
  "Active",
  "Grace",
  "Expired",
  "Canceled",
];

/**
 * What one provider event does to one standing phase. A total table, so the
 * edge's `if` chain is a lookup: an event that records nothing is `ignored`,
 * not a missing branch. The rows are the provider's four kinds; the columns
 * are the same phases `STANDING_PHASE_TRANSITIONS` uses.
 *
 * A one-off pack is handled before the table: it buys credits whether or not a
 * standing exists, so it is `purchased` in every phase and never an activation.
 *
 * @primitive
 */
export const WEBHOOK_TRANSITIONS: Record<WebhookKind, Record<StandingPhaseTag, WebhookAction>> = {
  checkout_completed: {
    Unsubscribed: "activated",
    Trialing: "ignored",
    Active: "ignored",
    Grace: "ignored",
    Expired: "activated",
    Canceled: "activated",
  },
  payment_succeeded: {
    Unsubscribed: "activated",
    Trialing: "ignored",
    Active: "ignored",
    Grace: "recovered",
    Expired: "activated",
    Canceled: "ignored",
  },
  payment_failed: {
    Unsubscribed: "ignored",
    Trialing: "failed",
    Active: "failed",
    Grace: "failed",
    Expired: "ignored",
    Canceled: "ignored",
  },
  subscription_canceled: {
    Unsubscribed: "ignored",
    Trialing: "canceled",
    Active: "canceled",
    Grace: "canceled",
    Expired: "ignored",
    Canceled: "ignored",
  },
};

/**
 * The action one delivery names, from the event's kind and the standing it
 * found. A caller that has already handled `oneOff` can use this to skip the
 * branch chain; the operation uses it for exactly that.
 *
 * ### Classifying a delivery
 * **Example:** A payment failure for an expired account
 * ```typescript
 * webhookActionOf("payment_failed", expiredState); // "ignored"
 * ```
 *
 * @primitive
 */
export const webhookActionOf = (kind: WebhookKind, state: SubscriptionState): WebhookAction => {
  const phase =
    state._tag === "Unsubscribed" ? "Unsubscribed" : standingPhaseTagOfStatus(state.status);

  return WEBHOOK_TRANSITIONS[kind][phase];
};

/**
 * The webhook edge as a binding: the model's services resolved once, an event
 * applied per delivery. A Worker route builds this beside its other bindings, so
 * a delivery does not re-resolve the model on every call.
 *
 * The edge is idempotent, not a reorderer. A redelivery applies once by the
 * provider event id; a checkout for a standing that already exists is a replay,
 * never a second activation. A fact that arrives before the standing it
 * describes — a failed payment before checkout — is ignored rather than
 * buffered: the provider's retry is the recovery, and the edge never invents an
 * order across facts.
 */
export const webhookOperation = Effect.fn("Paykit.Webhook")(function* () {
  const subscription = yield* Subscription;
  const catalog = yield* CatalogService;

  /**
   * Translate one provider event into a command and apply it. The provider
   * event id is the command id; a redelivery therefore replays rather than
   * recording twice.
   */
  const apply = (event: WebhookEvent) =>
    Effect.gen(function* () {
      const ref = Subscription.ref(event.account);
      const state = yield* subscription.state(ref);
      // A one-off tier is a pack, not a standing: a payment for it adds
      // never-expiring credits to the pool the account already holds. It does
      // not activate, change the tier or create a second subscription.
      const sold = event.tier === undefined ? null : planOf(catalog, event.tier);
      const oneOff = sold !== null && (sold.kind ?? "subscription") === "one_off";

      const purchase = Effect.gen(function* () {
        if (sold === null) {
          return yield* new WebhookInvalid({ event: event.id, field: "tier" });
        }

        const purchase = purchaseCreditsInputOf(catalog, sold.id);

        if (purchase === null) {
          return yield* new PlanNotInCatalog({ tier: sold.id });
        }

        yield* asSystem(
          subscription.send(ref, new PurchaseCredits(purchase), { commandId: event.id }),
        );

        return "purchased" as const satisfies WebhookAction;
      });

      const activate = Effect.gen(function* () {
        if (event.tier === undefined) {
          return yield* new WebhookInvalid({ event: event.id, field: "tier" });
        }

        // The quote a checkout stored is the deal, not the catalog's defaults:
        // a hosted purchase names the plan and not the negotiated allowances
        // (ADR 0042 §1). A quote for another plan is stale; a custom plan with
        // no quote cannot be activated from the catalog without recording a
        // deal nobody agreed to.
        const pending = state.pendingActivation;

        if (pending !== undefined && pending.tier !== event.tier) {
          return yield* new PendingActivationStale({
            account: event.account,
            tier: event.tier,
            pendingTier: pending.tier,
          });
        }

        if (pending === undefined && sold?.custom === true) {
          return yield* new PendingActivationMissing({
            account: event.account,
            tier: event.tier,
          });
        }

        const activation =
          pending === undefined
            ? subscribeInputOf(catalog, event.tier, {
                ...(event.anchorTz === undefined ? {} : { anchorTz: event.anchorTz }),
                ...(event.chargeId === undefined ? {} : { chargeId: event.chargeId }),
              })
            : {
                ...pending,
                ...((pending.anchorTz ?? event.anchorTz) === undefined
                  ? {}
                  : { anchorTz: pending.anchorTz ?? event.anchorTz }),
                ...(event.chargeId === undefined ? {} : { chargeId: event.chargeId }),
              };

        if (activation === null) {
          return yield* new PlanNotInCatalog({ tier: event.tier });
        }

        // A delivery that raced a newer activation is a replay, not a failed
        // hook: the command refuses to reset an open standing, and the provider
        // does not need to retry it.
        return yield* asSystem(
          subscription.send(ref, new SubscribeCommand(activation), { commandId: event.id }),
        ).pipe(
          Effect.as("activated" as const satisfies WebhookAction),
          Effect.catchTag("AlreadySubscribed", () =>
            Effect.succeed("ignored" as const satisfies WebhookAction),
          ),
        );
      });

      // A pack is a purchase in every phase; everything else is the table.
      if (oneOff && (event.kind === "checkout_completed" || event.kind === "payment_succeeded")) {
        return yield* purchase;
      }

      // The amount and currency are evidence a payment path needs before the
      // table can say "recovered" or "activated"; an ignored delivery still
      // fails the same validation it always did.
      if (event.kind === "payment_succeeded") {
        if (event.amount === undefined) {
          return yield* new WebhookInvalid({ event: event.id, field: "amount" });
        }

        if (event.currency === undefined) {
          return yield* new WebhookInvalid({ event: event.id, field: "currency" });
        }
      }

      switch (webhookActionOf(event.kind, state)) {
        case "purchased":
          return yield* purchase;
        case "activated":
          return yield* activate;
        case "recovered": {
          if (event.amount === undefined || event.currency === undefined) {
            return yield* new WebhookInvalid({ event: event.id, field: "amount" });
          }

          yield* asSystem(
            subscription.send(
              ref,
              new RecordPayment({
                amount: event.amount,
                currency: event.currency,
                ...(event.chargeId === undefined ? {} : { chargeId: event.chargeId }),
              }),
              { commandId: event.id },
            ),
          );

          return "recovered" as const satisfies WebhookAction;
        }

        case "failed": {
          const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
          yield* asSystem(
            subscription.send(
              ref,
              new RecordPaymentFailure({
                reason: event.reason ?? "payment_failed",
                graceUntil: event.graceUntil ?? DateTime.add(now, { days: 7 }),
              }),
              { commandId: event.id },
            ),
          );

          return "failed" as const satisfies WebhookAction;
        }

        case "canceled":
          // A cancellation is a standing change, not only an active-account
          // one: a customer may cancel while in grace or on a trial. Allowing
          // it there is what lets a failure and a cancellation commute.
          return yield* asSystem(
            subscription.send(ref, new ScheduleCancellation(), { commandId: event.id }),
          ).pipe(
            Effect.as("canceled" as const satisfies WebhookAction),
            Effect.catchTag("AlreadyCanceled", () =>
              Effect.succeed("ignored" as const satisfies WebhookAction),
            ),
          );
        case "ignored":
          return "ignored" as const satisfies WebhookAction;
      }
    });

  return apply;
});

/**
 * Translate one provider webhook into a command, reading the model from the
 * context. The provider event id is the command id; a redelivery therefore
 * replays rather than recording twice.
 */
export const handleWebhook = (event: WebhookEvent) =>
  webhookOperation().pipe(Effect.flatMap((apply) => apply(event)));

/**
 * Complete a checkout from the provider's `checkout_completed` webhook. The
 * provider event id is the command id, so a redelivery replays rather than
 * activating twice.
 */
export const completeCheckout = (event: Omit<WebhookEvent, "kind">) =>
  handleWebhook({ ...event, kind: "checkout_completed" });
