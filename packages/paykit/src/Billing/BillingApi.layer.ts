import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BillingApi } from "../BillingApi.api.ts";
import { CatalogService } from "../CatalogService.ts";
import { evaluateCheck } from "../Check.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "../Subscription/TierNotInCatalog.rejection.ts";
import { scheduleTierChangeInputOf, subscribeInputOf } from "../TierCommand.ts";
import { BindingCall, callOptionsOf, mapBindingFailure } from "./Bindings.ts";
import { Resume, ScheduleCancellation, toCancelError, toResumeError } from "./Cancel.binding.ts";
import { Check, toCheckError } from "./Check.binding.ts";
import { ConsumeCredits, toConsumeCreditsError } from "./ConsumeCredits.binding.ts";
import { Hold, toHoldError } from "./Hold.binding.ts";
import { ReleaseHold, toReleaseHoldError } from "./ReleaseHold.binding.ts";
import {
  ScheduleTierChange,
  toScheduleTierChangeError,
  toWithdrawTierChangeError,
  WithdrawTierChange,
} from "./ScheduleTierChange.binding.ts";
import { SettleHold, toSettleHoldError } from "./SettleHold.binding.ts";
import { StartTrial, toStartTrialError } from "./StartTrial.binding.ts";
import { toTrackUsageError, TrackUsage, usageOutcome } from "./TrackUsage.binding.ts";

/** A layer's own failure, as the union its binding declares. */
const bound = mapBindingFailure;

/**
 * Every paykit tenant binding, implemented over `BillingApi` — the Api's own
 * `Session` middleware decides whether this caller may act for this account,
 * and its reply decoding turns a rejection back into the class a caller
 * matches.
 *
 * The layer is **protocol-agnostic**: it resolves `BillingApi.Client`, and the
 * deployment picks the protocol beside it.
 *
 * ```typescript
 * Layer.provide(BillingApi, BillingApi.layerClientInProcess)   // same host
 * Layer.provide(BillingApi, BillingApi.layerClientHttp(url))   // another service
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
                feature: request.feature,
                amount: request.amount,
                ...(request.dimension === undefined ? {} : { dimension: request.dimension }),
                dedupeKey: request.dedupeKey,
              },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toTrackUsageError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );
          return usageOutcome(view, request);
        });
      });
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
          const view = yield* bound(toCheckError)(client.Entitlements.get(id, options()));
          return evaluateCheck(view, { account, ...request });
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
          yield* bound(toSettleHoldError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );
          return receipt.reply;
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
          yield* bound(toReleaseHoldError)(
            client.Entitlements.get(id, { atLeast: receipt, ...options() }),
          );
          return receipt.reply;
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
      const client = yield* BillingApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.ScheduleCancellation")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;
        return Effect.fn("Paykit.ScheduleCancellation.schedule")(function* (request) {
          const receipt = yield* bound(toCancelError)(
            // An inputless command takes its options third: input, then options.
            client.ScheduleCancellation(id, {}, options(request.dedupeKey)),
          );
          const view = yield* bound(toCancelError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );
          return { cancelAtPeriodEnd: view?.cancelAtPeriodEnd ?? false };
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
            client.Resume(id, {}, options(request.dedupeKey)),
          );
          const view = yield* bound(toResumeError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );
          return { cancelAtPeriodEnd: view?.cancelAtPeriodEnd ?? false };
        });
      });
    }),
  ),
  // The catalog joins the payload here, exactly as the in-process layer does:
  // a caller names the tier and `CatalogGuard` sees a command that agrees with
  // the deploy.
  Layer.effect(
    ScheduleTierChange,
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const catalog = yield* CatalogService;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.ScheduleTierChange")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;
        return Effect.fn("Paykit.ScheduleTierChange.schedule")(function* (request) {
          const scheduled = scheduleTierChangeInputOf(catalog, request.tier);
          if (scheduled === null) {
            return yield* bound(toScheduleTierChangeError)(
              Effect.fail(new TierNotInCatalog({ tier: request.tier })),
            );
          }
          const receipt = yield* bound(toScheduleTierChangeError)(
            client.ScheduleTierChange(id, scheduled, options(request.dedupeKey)),
          );
          const view = yield* bound(toScheduleTierChangeError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );
          return { pendingTier: view?.pendingTier?.tier ?? null };
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
      const client = yield* BillingApi.Client;
      const catalog = yield* CatalogService;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.StartTrial")(function* (account) {
        // The Api speaks branded account ids; a binding takes the id as it
        // arrives and brands it once, here, through the aggregate's own ref.
        const id = Subscription.ref(account).id;
        return Effect.fn("Paykit.StartTrial.begin")(function* (request) {
          const grant = subscribeInputOf(
            catalog,
            request.tier,
            request.anchorTz === undefined ? {} : { anchorTz: request.anchorTz },
          );
          if (grant === null) {
            return yield* bound(toStartTrialError)(
              Effect.fail(new TierNotInCatalog({ tier: request.tier })),
            );
          }
          const receipt = yield* bound(toStartTrialError)(
            client.StartTrial(
              id,
              { ...grant, trialEndsAt: request.trialEndsAt },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toStartTrialError)(
            client.BillingState.get(id, { atLeast: receipt, ...options() }),
          );
          return {
            tier: view?.tier ?? request.tier,
            status: view?.status ?? "trialing",
            trialEndsAt: view?.trialEndsAt ?? null,
          };
        });
      });
    }),
  ),
);
