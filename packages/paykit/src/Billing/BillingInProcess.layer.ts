import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { asSystem } from "../Auth/Actor.ts";
import { CatalogService } from "../CatalogService.ts";
import { evaluateCheck } from "../Check.ts";
import { Payments, PaymentsRouter, ProviderCapabilityMissing, providerFor } from "../Payments.ts";
import { BillingState } from "../Subscription/BillingState.view.ts";
import { ChangeTier as ChangeTierCommand } from "../Subscription/ChangeTier.command.ts";
import { ConsumeCredits as ConsumeCreditsCommand } from "../Subscription/ConsumeCredits.command.ts";
import { Entitlements } from "../Subscription/Entitlements.view.ts";
import { Hold as HoldCommand } from "../Subscription/Hold.command.ts";
import { RecordQuantityProrationInvoice } from "../Subscription/QuantityProration.command.ts";
import { ReleaseHold as ReleaseHoldCommand } from "../Subscription/ReleaseHold.command.ts";
import { Resume as ResumeCommand } from "../Subscription/Resume.command.ts";
import { ScheduleCancellation as ScheduleCancellationCommand } from "../Subscription/ScheduleCancellation.command.ts";
import { ScheduleTierChange as ScheduleTierChangeCommand } from "../Subscription/ScheduleTierChange.command.ts";
import { SetQuantity as SetQuantityCommand } from "../Subscription/SetQuantity.command.ts";
import { SettleHold as SettleHoldCommand } from "../Subscription/SettleHold.command.ts";
import { StartTrial as StartTrialCommand } from "../Subscription/StartTrial.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "../Subscription/TierNotInCatalog.rejection.ts";
import { TrackUsage as TrackUsageCommand } from "../Subscription/TrackUsage.command.ts";
import { WithdrawTierChange as WithdrawTierChangeCommand } from "../Subscription/WithdrawTierChange.command.ts";
import { planChangeTier, scheduleTierChangeInputOf, subscribeInputOf } from "../TierCommand.ts";
import { webhookOperation } from "../Webhooks.ts";
import { mapBindingFailure } from "./Bindings.ts";
import { Resume, ScheduleCancellation, toCancelError, toResumeError } from "./Cancel.binding.ts";
import { ChangeTier, toChangeTierError } from "./ChangeTier.binding.ts";
import { chargeProrationOperation } from "./ChargeProration.operation.ts";
import {
  ChargeQuantityProration,
  chargeQuantityProrationOperation,
  toChargeQuantityProrationError,
} from "./ChargeQuantityProration.binding.ts";
import { Check, toCheckError } from "./Check.binding.ts";
import { ConsumeCredits, toConsumeCreditsError } from "./ConsumeCredits.binding.ts";
import { Hold, toHoldError } from "./Hold.binding.ts";
import { List, toListError } from "./List.binding.ts";
import { listOperation } from "./List.operation.ts";
import {
  ChargeProration,
  Portal,
  toChargeProrationError,
  toPortalError,
} from "./Portal.binding.ts";
import { portalOperation } from "./Portal.operation.ts";
import { Preview, toPreviewError } from "./Preview.binding.ts";
import { previewOperation } from "./Preview.operation.ts";
import { ReleaseHold, toReleaseHoldError } from "./ReleaseHold.binding.ts";
import {
  ScheduleTierChange,
  toScheduleTierChangeError,
  toWithdrawTierChangeError,
  WithdrawTierChange,
} from "./ScheduleTierChange.binding.ts";
import { SetQuantity, toSetQuantityError } from "./SetQuantity.binding.ts";
import { SettleHold, toSettleHoldError } from "./SettleHold.binding.ts";
import { StartTrial, toStartTrialError } from "./StartTrial.binding.ts";
import { Subscribe, toSubscribeError } from "./Subscribe.binding.ts";
import { subscribeOperation } from "./Subscribe.operation.ts";
import { toTrackUsageError, TrackUsage, usageOutcome } from "./TrackUsage.binding.ts";
import { Webhook, toWebhookError } from "./Webhook.binding.ts";

/** A layer's own failure, as the union its binding declares. */
const bound = mapBindingFailure;

/** The tier a standing will move to at its boundary, or `null` when nothing is scheduled. */
const viewTier = (
  view: { readonly pendingTier?: { readonly tier: string } } | null,
): string | null => view?.pendingTier?.tier ?? null;

/**
 * Every paykit binding, implemented in the process that hosts the model.
 *
 * One layer for the whole tenant surface, because the clearance is the Api's and
 * not the operation's: a deployment that provides this layer can send exactly the
 * commands `BillingApi` serves, and nothing an operator can.
 *
 * Provide it beside the store, the catalog and the payments router. Swap it for
 * `BillingApiLayer` to host the model in a different service — no call site
 * changes.
 *
 * ### Providing the tenant surface
 * **Example:** A Worker that hosts the model
 * ```typescript
 * const World = Layer.mergeAll(BillingInProcess, catalogLayer(Catalog), provider.payments);
 *
 * fetch: Effect.gen(function* () {
 *   const trackUsage = yield* Paykit.TrackUsage(account);
 *   yield* trackUsage({ feature: "messages", amount: 1, dedupeKey: requestId });
 * });
 * ```
 *
 * @layer
 * @product Usage
 * @provides Paykit.TrackUsage
 */
export const BillingInProcess = Layer.mergeAll(
  Layer.effect(
    TrackUsage,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.TrackUsage")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.TrackUsage.record")(function* (request) {
          const receipt = yield* bound(toTrackUsageError)(
            asSystem(
              subscription.send(
                ref,
                new TrackUsageCommand({
                  feature: request.feature,
                  amount: request.amount,
                  ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                  ...(request.properties === undefined ? {} : { properties: request.properties }),
                  ...(request.properties === undefined ? {} : { properties: request.properties }),
                  dedupeKey: request.dedupeKey,
                }),
                { commandId: request.dedupeKey },
              ),
            ),
          );

          const view = yield* bound(toTrackUsageError)(
            entitlements.query(ref, { atLeast: receipt }),
          );

          return usageOutcome(Option.getOrNull(view), request);
        });
      });
    }),
  ),
  Layer.effect(
    ChargeQuantityProration,
    Effect.gen(function* () {
      const charge = yield* chargeQuantityProrationOperation();

      return Effect.fn("Paykit.ChargeQuantityProration")(function* (account) {
        return Effect.fn("Paykit.ChargeQuantityProration.account")(function* (request) {
          return yield* bound(toChargeQuantityProrationError)(charge(account, request));
        });
      });
    }),
  ),
  Layer.effect(
    SetQuantity,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;
      const router = Option.getOrNull(yield* Effect.serviceOption(PaymentsRouter));

      return Effect.fn("Paykit.SetQuantity")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.SetQuantity.set")(function* (request) {
          const receipt = yield* bound(toSetQuantityError)(
            asSystem(
              subscription.send(
                ref,
                new SetQuantityCommand({
                  feature: request.feature,
                  quantity: request.quantity,
                  dedupeKey: request.dedupeKey,
                }),
                { commandId: request.dedupeKey },
              ),
            ),
          );

          const view = yield* bound(toSetQuantityError)(
            entitlements.query(ref, { atLeast: receipt }),
          );

          const known = Option.getOrNull(view);
          // A provider that owns the subscription item's quantity is told the
          // new total. `immediate` makes it invoice the difference; `none`
          // leaves the next period to bill it. The local proration is still the
          // record; an invoice the vendor opens is recorded on it.
          const state = yield* subscription.state(ref);

          if (state._tag === "Subscribed" && router !== null) {
            const chosen = providerFor(router, state.refs);

            const vendorSubscription =
              chosen === null ? undefined : state.refs[chosen.name]?.subscription;

            const allowance = state.allowances[request.feature];

            if (chosen !== null && vendorSubscription !== undefined && allowance !== undefined) {
              if (chosen.capabilities.has("quantity")) {
                const attempt = Effect.gen(function* () {
                  const payments = yield* Effect.serviceOption(Payments);

                  if (Option.isNone(payments)) {
                    return yield* new ProviderCapabilityMissing({
                      provider: chosen.name,
                      op: "setQuantity",
                    });
                  }

                  const result = yield* Option.getOrThrow(payments).setQuantity({
                    account,
                    subscription: vendorSubscription,
                    tier: state.tier,
                    feature: request.feature,
                    quantity: request.quantity,
                    proration: allowance.prorate === "period_end" ? "none" : "immediate",
                    commandId: request.dedupeKey,
                  });

                  const proration = receipt.reply.proration;

                  if (result.invoiceId !== undefined && proration !== undefined) {
                    // A second attempt at the same change finds the invoice
                    // already recorded; that is the replay, not a failure.
                    yield* bound(toSetQuantityError)(
                      asSystem(
                        subscription.send(
                          ref,
                          new RecordQuantityProrationInvoice({
                            prorationId: request.dedupeKey,
                            invoiceId: result.invoiceId,
                            amount: proration.due,
                            currency: proration.currency,
                          }),
                          { commandId: `quantity-proration:${request.dedupeKey}` },
                        ),
                      ).pipe(Effect.catchTag("NoQuantityProrationDue", () => Effect.void)),
                    );
                  }
                });

                yield* chosen === null ? attempt : Effect.provide(attempt, chosen.payments);
              }
            }
          }

          // A no-op decision records no event, so the reply cannot carry the
          // quantity; the read model just caught up to the change and is the
          // same number a caller reads next.
          return {
            quantity: known?.features[request.feature]?.quantity ?? receipt.reply.quantityAfter,
            ...(receipt.reply.proration === undefined
              ? {}
              : { proration: receipt.reply.proration }),
          };
        });
      });
    }),
  ),
  Layer.effect(
    Check,
    Effect.gen(function* () {
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.Check")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.Check.ask")(function* (request) {
          const view = yield* bound(toCheckError)(entitlements.query(ref));

          return evaluateCheck(Option.getOrNull(view), { account, ...request });
        });
      });
    }),
  ),
  Layer.effect(
    Hold,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.Hold")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.Hold.place")(function* (request) {
          const holdId = request.holdId ?? request.dedupeKey;

          const receipt = yield* bound(toHoldError)(
            asSystem(
              subscription.send(
                ref,
                new HoldCommand({
                  holdId,
                  feature: request.feature,
                  amount: request.amount,
                  ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                  ...(request.properties === undefined ? {} : { properties: request.properties }),
                  ...(request.properties === undefined ? {} : { properties: request.properties }),
                  ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
                  dedupeKey: request.dedupeKey,
                }),
                { commandId: request.dedupeKey },
              ),
            ),
          );

          const view = yield* bound(toHoldError)(entitlements.query(ref, { atLeast: receipt }));
          const remaining = Option.getOrNull(view)?.features[request.feature]?.remaining ?? null;

          return { holdId, remaining };
        });
      });
    }),
  ),
  Layer.effect(
    SettleHold,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.SettleHold")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.SettleHold.hold")(function* (request) {
          const receipt = yield* bound(toSettleHoldError)(
            asSystem(
              subscription.send(
                ref,
                new SettleHoldCommand({
                  holdId: request.holdId,
                  ...(request.amount === undefined ? {} : { amount: request.amount }),
                  dedupeKey: request.dedupeKey,
                }),
                { commandId: request.dedupeKey },
              ),
            ),
          );

          // The reply is this command's own answer, and the read is the next
          // caller's: a `Check` straight after a settle must see the usage the
          // settle recorded, so the wait is the same one `TrackUsage` makes.
          yield* bound(toSettleHoldError)(entitlements.query(ref, { atLeast: receipt }));

          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ReleaseHold,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.ReleaseHold")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.ReleaseHold.hold")(function* (request) {
          const receipt = yield* bound(toReleaseHoldError)(
            asSystem(
              subscription.send(ref, new ReleaseHoldCommand({ holdId: request.holdId }), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          yield* bound(toReleaseHoldError)(entitlements.query(ref, { atLeast: receipt }));

          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ConsumeCredits,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;

      return Effect.fn("Paykit.ConsumeCredits")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.ConsumeCredits.spend")(function* (request) {
          const receipt = yield* bound(toConsumeCreditsError)(
            asSystem(
              subscription.send(ref, new ConsumeCreditsCommand({ amount: request.amount }), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          yield* bound(toConsumeCreditsError)(entitlements.query(ref, { atLeast: receipt }));

          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ScheduleCancellation,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;

      return Effect.fn("Paykit.ScheduleCancellation")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.ScheduleCancellation.schedule")(function* (request) {
          const receipt = yield* bound(toCancelError)(
            asSystem(
              subscription.send(ref, new ScheduleCancellationCommand(), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          const view = yield* bound(toCancelError)(billing.query(ref, { atLeast: receipt }));

          return { cancelAtPeriodEnd: Option.getOrNull(view)?.cancelAtPeriodEnd ?? false };
        });
      });
    }),
  ),
  Layer.effect(
    Resume,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;

      return Effect.fn("Paykit.Resume")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.Resume.undo")(function* (request) {
          const receipt = yield* bound(toResumeError)(
            asSystem(subscription.send(ref, new ResumeCommand(), { commandId: request.dedupeKey })),
          );

          const view = yield* bound(toResumeError)(billing.query(ref, { atLeast: receipt }));

          return { cancelAtPeriodEnd: Option.getOrNull(view)?.cancelAtPeriodEnd ?? false };
        });
      });
    }),
  ),
  // The one operation binding: a tier change carries its own allowances and
  // price because `decide` is pure, and the proration is computed from the
  // standing — so the catalog and the state are read here, not carried by the
  // caller. `Preview` quotes the same plan without sending it.
  Layer.effect(
    ChangeTier,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const subscription = yield* Subscription;

      return Effect.fn("Paykit.ChangeTier")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.ChangeTier.move")(function* (request) {
          const state = yield* subscription.state(ref);
          const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);

          const plan =
            state._tag === "Subscribed" ? planChangeTier(catalog, request.tier, state, now) : null;

          if (plan === null) {
            return yield* bound(toChangeTierError)(
              Effect.fail(new TierNotInCatalog({ tier: request.tier })),
            );
          }

          yield* bound(toChangeTierError)(
            asSystem(
              subscription.send(ref, new ChangeTierCommand(plan.input), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          return { tier: request.tier, proration: plan.proration };
        });
      });
    }),
  ),
  Layer.effect(
    ScheduleTierChange,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const subscription = yield* Subscription;
      const billing = yield* BillingState;

      return Effect.fn("Paykit.ScheduleTierChange")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.ScheduleTierChange.schedule")(function* (request) {
          const state = yield* subscription.state(ref);

          const scheduled = scheduleTierChangeInputOf(
            catalog,
            request.tier,
            state._tag === "Subscribed" ? state.currency : undefined,
          );

          if (scheduled === null) {
            return yield* bound(toScheduleTierChangeError)(
              Effect.fail(new TierNotInCatalog({ tier: request.tier })),
            );
          }

          const receipt = yield* bound(toScheduleTierChangeError)(
            asSystem(
              subscription.send(ref, new ScheduleTierChangeCommand(scheduled), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          const view = yield* bound(toScheduleTierChangeError)(
            billing.query(ref, { atLeast: receipt }),
          );

          return { pendingTier: viewTier(Option.getOrNull(view)) };
        });
      });
    }),
  ),
  Layer.effect(
    WithdrawTierChange,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;

      return Effect.fn("Paykit.WithdrawTierChange")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.WithdrawTierChange.take")(function* (request) {
          const receipt = yield* bound(toWithdrawTierChangeError)(
            asSystem(
              subscription.send(ref, new WithdrawTierChangeCommand(), {
                commandId: request.dedupeKey,
              }),
            ),
          );

          const view = yield* bound(toWithdrawTierChangeError)(
            billing.query(ref, { atLeast: receipt }),
          );

          return { pendingTier: viewTier(Option.getOrNull(view)) };
        });
      });
    }),
  ),
  Layer.effect(
    StartTrial,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const subscription = yield* Subscription;
      const billing = yield* BillingState;

      return Effect.fn("Paykit.StartTrial")(function* (account) {
        const ref = Subscription.ref(account);

        return Effect.fn("Paykit.StartTrial.begin")(function* (request) {
          const grant = subscribeInputOf(catalog, request.tier, {
            ...(request.anchorTz === undefined ? {} : { anchorTz: request.anchorTz }),
            ...(request.currency === undefined ? {} : { currency: request.currency }),
          });

          if (grant === null) {
            return yield* bound(toStartTrialError)(
              Effect.fail(new TierNotInCatalog({ tier: request.tier })),
            );
          }

          const receipt = yield* bound(toStartTrialError)(
            asSystem(
              subscription.send(
                ref,
                new StartTrialCommand({ ...grant, trialEndsAt: request.trialEndsAt }),
                { commandId: request.dedupeKey },
              ),
            ),
          );

          const view = yield* bound(toStartTrialError)(billing.query(ref, { atLeast: receipt }));
          const standing = Option.getOrNull(view);

          return {
            tier: standing?.tier ?? request.tier,
            status: standing?.status ?? "trialing",
            trialEndsAt: standing?.trialEndsAt ?? null,
          };
        });
      });
    }),
  ),
  // The two operations a checkout page needs. Both delegate to the binding that
  // already walks the provider path, so there is one implementation of a
  // purchase and one of a quote, and this layer's job is the tag and the types.
  Layer.effect(
    Subscribe,
    Effect.gen(function* () {
      const subscribe = yield* subscribeOperation();

      return Effect.fn("Paykit.Subscribe")(function* (account) {
        return Effect.fn("Paykit.Subscribe.start")(function* (request) {
          return yield* bound(toSubscribeError)(
            subscribe({
              account,
              tier: request.tier,
              ...(request.anchorTz === undefined ? {} : { anchorTz: request.anchorTz }),
              ...(request.currency === undefined ? {} : { currency: request.currency }),
            }),
          );
        });
      });
    }),
  ),
  Layer.effect(
    Preview,
    Effect.gen(function* () {
      const preview = yield* previewOperation();

      return Effect.fn("Paykit.Preview")(function* (account) {
        return Effect.fn("Paykit.Preview.decide")(function* (request) {
          return yield* bound(toPreviewError)(preview({ account, command: request.command }));
        });
      });
    }),
  ),
  Layer.effect(
    Portal,
    Effect.gen(function* () {
      const portal = yield* portalOperation();

      return Effect.fn("Paykit.Portal")(function* (account) {
        return Effect.fn("Paykit.Portal.open")(function* () {
          return yield* bound(toPortalError)(portal({ account }));
        });
      });
    }),
  ),
  Layer.effect(
    ChargeProration,
    Effect.gen(function* () {
      const chargeProration = yield* chargeProrationOperation();

      return Effect.fn("Paykit.ChargeProration")(function* (account) {
        return Effect.fn("Paykit.ChargeProration.account")(function* () {
          return yield* bound(toChargeProrationError)(
            chargeProration({ account }).pipe(
              Effect.catchTag("NoProrationDue", () =>
                Effect.succeed({ outcome: "nothing" as const }),
              ),
            ),
          );
        });
      });
    }),
  ),
  Layer.effect(
    List,
    Effect.gen(function* () {
      const list = yield* listOperation();

      return Effect.fn("Paykit.List")(function* () {
        return Effect.fn("Paykit.List.page")(function* (query) {
          return yield* bound(toListError)(list(query));
        });
      });
    }),
  ),
  Layer.effect(
    Webhook,
    Effect.gen(function* () {
      const webhook = yield* webhookOperation();

      return Effect.fn("Paykit.Webhook")(function* () {
        return Effect.fn("Paykit.Webhook.apply")(function* (event) {
          return yield* bound(toWebhookError)(webhook(event));
        });
      });
    }),
  ),
);
