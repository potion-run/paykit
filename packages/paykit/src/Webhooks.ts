import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asSystem } from "./Auth/Actor.ts";
import { allowancesOf, tierOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import { RecordPayment } from "./Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "./Subscription/RecordPaymentFailure.command.ts";
import { ScheduleCancellation } from "./Subscription/ScheduleCancellation.command.ts";
import { Subscribe as SubscribeCommand } from "./Subscription/Subscribe.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "./Subscription/TierNotInCatalog.rejection.ts";

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
  "recovered",
  "failed",
  "canceled",
  "ignored",
]);
export type WebhookAction = typeof WebhookAction.Type;

/**
 * The webhook edge as a binding: the model's services resolved once, an event
 * applied per delivery. A Worker route builds this beside its other bindings, so
 * a delivery does not re-resolve the model on every call.
 */
export const Webhook = Effect.fn("Paykit.Webhook")(function* () {
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

      const activate = Effect.gen(function* () {
        if (event.tier === undefined) {
          return yield* new WebhookInvalid({ event: event.id, field: "tier" });
        }
        const allowances = allowancesOf(catalog, event.tier);
        if (allowances === null) {
          return yield* new TierNotInCatalog({ tier: event.tier });
        }
        const tier = tierOf(catalog, event.tier);
        yield* asSystem(
          subscription.send(
            ref,
            new SubscribeCommand({
              tier: event.tier,
              allowances,
              ...(tier?.price === undefined ? {} : { price: tier.price }),
              ...(event.anchorTz === undefined ? {} : { anchorTz: event.anchorTz }),
            }),
            { commandId: event.id },
          ),
        );
        return "activated" as const satisfies WebhookAction;
      });

      switch (event.kind) {
        case "checkout_completed":
          return yield* activate;

        case "payment_succeeded": {
          if (event.amount === undefined) {
            return yield* new WebhookInvalid({ event: event.id, field: "amount" });
          }
          if (event.currency === undefined) {
            return yield* new WebhookInvalid({ event: event.id, field: "currency" });
          }
          if (state._tag === "Subscribed" && state.status === "grace") {
            yield* asSystem(
              subscription.send(
                ref,
                new RecordPayment({ amount: event.amount, currency: event.currency }),
                { commandId: event.id },
              ),
            );
            return "recovered" as const satisfies WebhookAction;
          }
          if (state._tag === "Unsubscribed" || state.status === "expired") {
            return yield* activate;
          }
          return "ignored" as const satisfies WebhookAction;
        }

        case "payment_failed": {
          if (state._tag !== "Subscribed" || state.status === "canceled") {
            return "ignored" as const satisfies WebhookAction;
          }
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

        case "subscription_canceled": {
          if (state._tag !== "Subscribed" || state.status !== "active") {
            return "ignored" as const satisfies WebhookAction;
          }
          return yield* asSystem(
            subscription.send(ref, new ScheduleCancellation(), { commandId: event.id }),
          ).pipe(
            Effect.as("canceled" as const satisfies WebhookAction),
            Effect.catchTag("AlreadyCanceled", () =>
              Effect.succeed("ignored" as const satisfies WebhookAction),
            ),
          );
        }
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
  Webhook().pipe(Effect.flatMap((apply) => apply(event)));

/**
 * Complete a checkout from the provider's `checkout_completed` webhook. The
 * provider event id is the command id, so a redelivery replays rather than
 * activating twice.
 */
export const completeCheckout = (event: Omit<WebhookEvent, "kind">) =>
  handleWebhook({ ...event, kind: "checkout_completed" });
