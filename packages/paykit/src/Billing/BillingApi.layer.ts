import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { balanceOfScope, emptyBalance } from "../Balance.ts";
import { BillingApi } from "../BillingApi.api.ts";
import { evaluateCheck } from "../Check.ts";
import { CUSTOMER_SCOPE, EntityId, entityScope } from "../Customer.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { BalancesLive, BalancesRead, toBalancesReadError } from "./Balances.layer.ts";
import { BindingCall, callOptionsOf, mapBindingFailure, type ReceiptRef } from "./Bindings.ts";
import { Resume, ScheduleCancellation, toCancelError, toResumeError } from "./Cancel.binding.ts";
import { Check, CheckLockKeyMissing, toCheckError } from "./Check.binding.ts";
import { BillingCommands } from "./Commands.rpc.ts";
import { ConsumeCredits, toConsumeCreditsError } from "./ConsumeCredits.binding.ts";
import {
  CreateCustomer,
  createCustomerCommandId,
  toCreateCustomerError,
} from "./CreateCustomer.binding.ts";
import { toCustomersError } from "./Customers.binding.ts";
import { CustomersLive, CustomersRead } from "./Customers.layer.ts";
import { toEntitiesError } from "./Entities.binding.ts";
import { EntitiesLive, EntitiesRead, EntityWrites } from "./Entities.layer.ts";
import { GrantBalance, toGrantBalanceError } from "./GrantBalance.binding.ts";
import { Hold, toHoldError } from "./Hold.binding.ts";
import { ReleaseHold, toReleaseHoldError } from "./ReleaseHold.binding.ts";
import {
  ScheduleTierChange,
  toScheduleTierChangeError,
  toWithdrawTierChangeError,
  WithdrawTierChange,
} from "./ScheduleTierChange.binding.ts";
import { SetBillingControls, toSetBillingControlsError } from "./SetBillingControls.binding.ts";
import { SetQuantity, toSetQuantityError } from "./SetQuantity.binding.ts";
import { SettleHold, toSettleHoldError } from "./SettleHold.binding.ts";
import { SetUsage, toSetUsageError } from "./SetUsage.binding.ts";
import { StartTrial, toStartTrialError } from "./StartTrial.binding.ts";
import { toTrackUsageError, TrackUsage, usageOutcome } from "./TrackUsage.binding.ts";
import { toTransferBalanceError } from "./TransferBalance.binding.ts";
import { TransferBalanceLive, TransferBalanceWrite } from "./TransferBalance.layer.ts";

/** A layer's own failure, as the union its binding declares. */
const bound = mapBindingFailure;

/** The base layer: each tenant verb over the Api client, before the reads are merged in. */
const BillingApiCore = Layer.mergeAll(
  Layer.effect(
    TrackUsage,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.TrackUsage")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.TrackUsage.record")(function* (request) {
          const receipt = yield* bound(toTrackUsageError)(
            client.TrackUsage(
              id,
              {
                feature: request.featureId,
                amount: request.value,
                ...(request.entityId === undefined ? {} : { entity: request.entityId }),
                ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                ...(request.properties === undefined ? {} : { properties: request.properties }),
                dedupeKey: request.idempotencyKey,
              },
              options(request.idempotencyKey),
            ),
          );

          const view = yield* bound(toTrackUsageError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return usageOutcome(view, account, request);
        });
      });
    }),
  ),
  Layer.effect(
    SetQuantity,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.SetQuantity")(function* (account) {
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.SetQuantity.set")(function* (request) {
          const receipt = yield* bound(toSetQuantityError)(
            client.SetQuantity(
              id,
              {
                feature: request.feature,
                quantity: request.quantity,
                ...(request.entityId === undefined ? {} : { entity: request.entityId }),
                dedupeKey: request.dedupeKey,
              },
              options(request.dedupeKey),
            ),
          );

          const view = yield* bound(toSetQuantityError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          // A no-op decision records no event, so the reply cannot carry the
          // quantity; the view just caught up to the change and is the same
          // number a caller reads next.
          const scoped =
            request.entityId === undefined
              ? view?.features[request.feature]
              : view?.entities?.[request.entityId]?.features[request.feature];

          return {
            quantity: scoped?.quantity ?? receipt.reply.quantityAfter,
            ...(receipt.reply.proration === undefined
              ? {}
              : { proration: receipt.reply.proration }),
          };
        });
      });
    }),
  ),
  Layer.effect(
    GrantBalance,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.GrantBalance")(function* (account) {
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.GrantBalance.grant")(function* (request) {
          const commandId =
            request.idempotencyKey ??
            `grant:${request.featureId}:${yield* Effect.sync(() => crypto.randomUUID())}`;

          const receipt = yield* bound(toGrantBalanceError)(
            client.GrantBalance(
              id,
              {
                feature: request.featureId,
                granted: request.granted,
                ...(request.entityId === undefined ? {} : { entity: request.entityId }),
                ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
              },
              options(commandId),
            ),
          );

          const view = yield* bound(toGrantBalanceError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return {
            featureId: request.featureId,
            granted: receipt.reply.granted,
            balance:
              (view === null ? null : balanceOfScope(view, request.featureId, request.entityId)) ??
              emptyBalance(
                account,
                request.featureId,
                request.entityId === undefined ? CUSTOMER_SCOPE : entityScope(request.entityId),
              ),
          };
        });
      });
    }),
  ),
  Layer.effect(
    SetUsage,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.SetUsage")(function* (account) {
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.SetUsage.set")(function* (request) {
          const commandId =
            request.idempotencyKey ??
            `usage:${request.featureId}:${request.usage}:${yield* Effect.sync(() => crypto.randomUUID())}`;

          const receipt = yield* bound(toSetUsageError)(
            client.SetUsage(
              id,
              {
                feature: request.featureId,
                usage: request.usage,
                ...(request.entityId === undefined ? {} : { entity: request.entityId }),
              },
              options(commandId),
            ),
          );

          const view = yield* bound(toSetUsageError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return {
            featureId: request.featureId,
            usage: receipt.reply.usage,
            remaining: receipt.reply.remaining,
            balance:
              (view === null ? null : balanceOfScope(view, request.featureId, request.entityId)) ??
              emptyBalance(
                account,
                request.featureId,
                request.entityId === undefined ? CUSTOMER_SCOPE : entityScope(request.entityId),
              ),
          };
        });
      });
    }),
  ),
  Layer.effect(
    SetBillingControls,
    Effect.gen(function* () {
      const commands = yield* BillingCommands;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.SetBillingControls")(function* (account) {
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.SetBillingControls.set")(function* (request) {
          return yield* bound(toSetBillingControlsError)(
            commands.setBillingControls(
              {
                target: id,
                ...(request.billingControls === undefined
                  ? {}
                  : { billingControls: request.billingControls }),
              },
              { headers: options().headers },
            ),
          );
        });
      });
    }),
  ),
  Layer.effect(
    CreateCustomer,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.CreateCustomer")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.CreateCustomer.record")(function* (request) {
          const commandId = request.dedupeKey ?? createCustomerCommandId(account, request);

          const receipt = yield* bound(toCreateCustomerError)(
            client.CreateCustomer(
              id,
              {
                ...(request.name === undefined ? {} : { name: request.name }),
                ...(request.email === undefined ? {} : { email: request.email }),
              },
              options(commandId),
            ),
          );

          const view = yield* bound(toCreateCustomerError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );

          const customer = view?.customer;

          return {
            ...(customer === undefined ? {} : { customer }),
            view: view ?? null,
          };
        });
      });
    }),
  ),
  Layer.effect(
    CustomersRead,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return {
        view: (account: string) =>
          bound(toCustomersError)(client.BillingState.get(Subscription.ref(account).id, options())),
      };
    }),
  ),
  Layer.effect(
    BalancesRead,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return {
        view: (account: string, atLeast?: ReceiptRef) =>
          bound(toBalancesReadError)(
            client.Entitlements.get(Subscription.ref(account).id, {
              ...(atLeast === undefined ? {} : { atLeast }),
              ...options(),
            }),
          ),
      };
    }),
  ),
  Layer.effect(
    EntitiesRead,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return {
        view: (account: string, atLeast?: ReceiptRef) =>
          bound(toEntitiesError)(
            client.BillingState.get(Subscription.ref(account).id, {
              ...(atLeast === undefined ? {} : { atLeast }),
              ...options(),
            }),
          ),
      };
    }),
  ),
  Layer.effect(
    EntityWrites,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return {
        create: (account, request) =>
          bound(toEntitiesError)(
            client.AttachEntity(
              Subscription.ref(account).id,
              {
                entityId: request.entityId,
                ...(request.name === undefined ? {} : { name: request.name }),
              },
              options(request.entityId),
            ),
          ),
        update: (account, request) =>
          bound(toEntitiesError)(
            client.UpdateEntity(
              Subscription.ref(account).id,
              {
                entityId: request.entityId,
                ...(request.name === undefined ? {} : { name: request.name }),
              },
              options(request.idempotencyKey),
            ),
          ),
        archive: (account, request) =>
          bound(toEntitiesError)(
            client.ArchiveEntity(
              Subscription.ref(account).id,
              { entityId: request.entityId },
              options(request.idempotencyKey),
            ),
          ),
      };
    }),
  ),
  Layer.effect(
    TransferBalanceWrite,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return {
        transfer: (account, request) =>
          bound(toTransferBalanceError)(
            client.TransferBalance(
              Subscription.ref(account).id,
              {
                from: request.from,
                to: request.to,
                feature: request.featureId,
                amount: request.amount,
              },
              options(request.idempotencyKey),
            ),
          ),
      };
    }),
  ),
  Layer.effect(
    Check,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.Check")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.Check.ask")(function* (request) {
          const requiredBalance = request.requiredBalance ?? 1;
          const input = { account, ...request, requiredBalance };

          const view = yield* bound(toCheckError)(client.Entitlements.get(id, options()));

          if (
            request.entityId !== undefined &&
            (view === null || view.entities?.[request.entityId] === undefined)
          ) {
            return yield* bound(toCheckError)(
              Effect.fail(
                new EntityUnknown({ account, entityId: EntityId.make(request.entityId) }),
              ),
            );
          }

          const answer = evaluateCheck(view, input);

          if (request.lock !== true || !answer.allowed) return answer;

          if (request.idempotencyKey === undefined) {
            return yield* bound(toCheckError)(
              Effect.fail(new CheckLockKeyMissing({ featureId: request.featureId })),
            );
          }

          const receipt = yield* bound(toCheckError)(
            client.Hold(
              id,
              {
                holdId: request.idempotencyKey,
                feature: request.featureId,
                amount: requiredBalance,
                ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                ...(request.properties === undefined ? {} : { properties: request.properties }),
                dedupeKey: request.idempotencyKey,
              },
              options(request.idempotencyKey),
            ),
          );

          const after = yield* bound(toCheckError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return { ...evaluateCheck(after, input), lockId: request.idempotencyKey };
        });
      });
    }),
  ),
  Layer.effect(
    Hold,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.Hold")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.Hold.place")(function* (request) {
          const holdId = request.holdId ?? request.dedupeKey;

          const receipt = yield* bound(toHoldError)(
            client.Hold(
              id,
              {
                holdId,
                feature: request.feature,
                amount: request.amount,
                ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                ...(request.properties === undefined ? {} : { properties: request.properties }),
                ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
                dedupeKey: request.dedupeKey,
              },
              options(request.dedupeKey),
            ),
          );

          const view = yield* bound(toHoldError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          const remaining = view?.features[request.feature]?.remaining ?? null;

          return { holdId, remaining };
        });
      });
    }),
  ),
  Layer.effect(
    SettleHold,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.SettleHold")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.SettleHold.hold")(function* (request) {
          const receipt = yield* bound(toSettleHoldError)(
            client.SettleHold(
              id,
              {
                holdId: request.holdId,
                ...(request.amount === undefined ? {} : { amount: request.amount }),
                dedupeKey: request.dedupeKey,
              },
              options(request.dedupeKey),
            ),
          );

          // The reply is this command's own answer, and the read is the next
          // caller's: a `Check` straight after a settle must see the usage the
          // settle recorded, so the wait is the same one `TrackUsage` makes.
          const view = yield* bound(toSettleHoldError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return {
            ...receipt.reply,
            featureId: receipt.reply.feature,
            balance:
              (view === null ? null : balanceOfScope(view, receipt.reply.feature)) ??
              emptyBalance(account, receipt.reply.feature),
          };
        });
      });
    }),
  ),
  Layer.effect(
    ReleaseHold,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.ReleaseHold")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.ReleaseHold.hold")(function* (request) {
          const receipt = yield* bound(toReleaseHoldError)(
            client.ReleaseHold(id, { holdId: request.holdId }, options(request.dedupeKey)),
          );

          // The reply is this command's own answer, and the read is the next
          // caller's: a `Check` straight after a settle must see the usage the
          // settle recorded, so the wait is the same one `TrackUsage` makes.
          const view = yield* bound(toReleaseHoldError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );

          return {
            ...receipt.reply,
            featureId: receipt.reply.feature,
            balance:
              (view === null ? null : balanceOfScope(view, receipt.reply.feature)) ??
              emptyBalance(account, receipt.reply.feature),
          };
        });
      });
    }),
  ),
  Layer.effect(
    ConsumeCredits,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.ConsumeCredits")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.ConsumeCredits.spend")(function* (request) {
          const receipt = yield* bound(toConsumeCreditsError)(
            client.ConsumeCredits(id, { amount: request.amount }, options(request.dedupeKey)),
          );

          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ScheduleCancellation,
    Effect.gen(function* () {
      const commands = yield* BillingCommands;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.ScheduleCancellation")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.ScheduleCancellation.schedule")(function* (request) {
          return yield* bound(toCancelError)(
            commands.scheduleCancellation(
              {
                target: id,
                ...(request.group === undefined ? {} : { group: request.group }),
                dedupeKey: request.dedupeKey,
              },
              { headers: options(request.dedupeKey).headers },
            ),
          );
        });
      });
    }),
  ),
  Layer.effect(
    Resume,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.Resume")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.Resume.undo")(function* (request) {
          const receipt = yield* bound(toResumeError)(
            request.group === undefined
              ? client.Resume(id, {}, options(request.dedupeKey))
              : client.UncancelGroup(id, { group: request.group }, options(request.dedupeKey)),
          );

          const view = yield* bound(toResumeError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );

          return {
            cancelAtPeriodEnd: view?.cancelAtPeriodEnd ?? false,
            ...(request.group === undefined ? {} : { group: request.group }),
          };
        });
      });
    }),
  ),
  // The catalog join belongs to the deployment now: a caller names the tier,
  // and `BillingCommands` expands it with the catalog the Worker was built
  // with before the model sees a command.
  Layer.effect(
    ScheduleTierChange,
    Effect.gen(function* () {
      const commands = yield* BillingCommands;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.ScheduleTierChange")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.ScheduleTierChange.schedule")(function* (request) {
          return yield* bound(toScheduleTierChangeError)(
            commands.scheduleTierChange(
              {
                target: id,
                tier: request.tier,
                ...(request.grants === undefined ? {} : { grants: request.grants }),
                ...(request.price === undefined ? {} : { price: request.price }),
                dedupeKey: request.dedupeKey,
              },
              { headers: options(request.dedupeKey).headers },
            ),
          );
        });
      });
    }),
  ),
  Layer.effect(
    WithdrawTierChange,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.WithdrawTierChange")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.WithdrawTierChange.take")(function* (request) {
          const receipt = yield* bound(toWithdrawTierChangeError)(
            client.WithdrawTierChange(id, {}, options(request.dedupeKey)),
          );

          const view = yield* bound(toWithdrawTierChangeError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );

          return { pendingTier: view?.pendingTier?.tier ?? null };
        });
      });
    }),
  ),
  Layer.effect(
    StartTrial,
    Effect.gen(function* () {
      const commands = yield* BillingCommands;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));

      return Effect.fn("Paykit.StartTrial")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;

        return Effect.fn("Paykit.StartTrial.begin")(function* (request) {
          return yield* bound(toStartTrialError)(
            commands.startTrial(
              {
                target: id,
                tier: request.tier,
                trialEndsAt: request.trialEndsAt,
                ...(request.anchorTz === undefined ? {} : { anchorTz: request.anchorTz }),
                ...(request.currency === undefined ? {} : { currency: request.currency }),
                dedupeKey: request.dedupeKey,
              },
              { headers: options(request.dedupeKey).headers },
            ),
          );
        });
      });
    }),
  ),
);

/**
 * Every paykit tenant binding, implemented over `BillingApi` — the Api's own
 * `Session` middleware decides whether this caller may act for this account,
 * and its reply decoding turns a rejection back into the class a caller
 * matches.
 *
 * The layer is **protocol-agnostic**: it resolves `BillingApi.Client` for the
 * commands the Api serves directly, and `BillingCommands` for the four whose
 * catalog terms the deployment joins. The deployment picks the protocol beside
 * each.
 *
 * ```typescript
 * Layer.provide(BillingApi, BillingApi.layerClientInProcess)          // same host
 * Layer.provide(BillingCommands, BillingCommandsLive)                 // same host
 * Layer.provide(BillingApi, BillingApi.layerClientHttp(url))          // another service
 * Layer.provide(BillingCommands, BillingCommandsClient(`${url}/commands`))
 * ```
 *
 * Read-your-write survives the transport: every verb reads `Entitlements` with
 * `atLeast` the receipt it just committed, exactly as the in-process layer waits
 * on the view, so a `Check` straight after a `TrackUsage` sees it on either.
 *
 * @layer
 * @product Usage
 * @provides Paykit.TrackUsage, Paykit.Check, Paykit.Hold, Paykit.SettleHold, Paykit.ReleaseHold
 */
export const BillingApiLayer = Layer.mergeAll(
  BillingApiCore,
  BalancesLive.pipe(Layer.provide(BillingApiCore)),
  CustomersLive.pipe(Layer.provide(BillingApiCore)),
  EntitiesLive.pipe(Layer.provide(BillingApiCore)),
  TransferBalanceLive.pipe(Layer.provide(BillingApiCore)),
);
