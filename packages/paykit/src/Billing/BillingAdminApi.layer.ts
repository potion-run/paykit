import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BillingAdminApi } from "../BillingAdminApi.api.ts";
import {
  EnterGrace,
  Expire,
  ExtendTrial,
  GrantCredits,
  RecordPayment,
  RecordPaymentFailure,
  Recover,
  standingSnapshot,
  toEnterGraceError,
  toExpireError,
  toExtendTrialError,
  toGrantCreditsError,
  toRecordPaymentError,
  toRecordPaymentFailureError,
  toRecoverError,
} from "./Admin.binding.ts";
import { BindingCall, callOptionsOf, mapBindingFailure } from "./Bindings.ts";

/** A layer's own failure, as the union its binding declares. */
const bound = mapBindingFailure;

/**
 * Every operator binding, implemented over `BillingAdminApi` — the Api whose
 * commands declare `Admin`, so a tenant session cannot reach one.
 *
 * Protocol-agnostic, like the tenant layer: resolve `BillingAdminApi.Client` and
 * the deployment chooses `layerClientInProcess` or `layerClientHttp(url)`. The
 * caller comes from {@link BindingCall}, which a console backend provides from
 * its own operator session.
 *
 * ### Providing the console from another service
 * **Example:** A console backend over HTTP
 * ```typescript
 * const Ops = Layer.provide(
 *   BillingAdminApiLayer,
 *   BillingAdminApi.layerClientHttp(env.BILLING_ADMIN_URL),
 * );
 * ```
 *
 * @layer
 * @product Console
 * @provides Paykit.GrantCredits
 */
export const BillingAdminApiLayer = Layer.mergeAll(
  Layer.effect(
    GrantCredits,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.GrantCredits")(function* (account) {
        return Effect.fn("Paykit.GrantCredits.add")(function* (request) {
          const receipt = yield* bound(toGrantCreditsError)(
            client.GrantCredits(account, { amount: request.amount }, options(request.dedupeKey)),
          );
          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ExtendTrial,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.ExtendTrial")(function* (account) {
        return Effect.fn("Paykit.ExtendTrial.extend")(function* (request) {
          const receipt = yield* bound(toExtendTrialError)(
            client.ExtendTrial(
              account,
              { trialEndsAt: request.trialEndsAt },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toExtendTrialError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
  Layer.effect(
    EnterGrace,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.EnterGrace")(function* (account) {
        return Effect.fn("Paykit.EnterGrace.open")(function* (request) {
          const receipt = yield* bound(toEnterGraceError)(
            client.EnterGrace(
              account,
              { graceUntil: request.graceUntil },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toEnterGraceError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
  Layer.effect(
    Recover,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.Recover")(function* (account) {
        return Effect.fn("Paykit.Recover.standing")(function* (request) {
          const receipt = yield* bound(toRecoverError)(
            client.Recover(account, {}, options(request.dedupeKey)),
          );
          const view = yield* bound(toRecoverError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
  Layer.effect(
    Expire,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.Expire")(function* (account) {
        return Effect.fn("Paykit.Expire.standing")(function* (request) {
          const receipt = yield* bound(toExpireError)(
            client.Expire(account, {}, options(request.dedupeKey)),
          );
          const view = yield* bound(toExpireError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
  Layer.effect(
    RecordPayment,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.RecordPayment")(function* (account) {
        return Effect.fn("Paykit.RecordPayment.record")(function* (request) {
          const receipt = yield* bound(toRecordPaymentError)(
            client.RecordPayment(
              account,
              { amount: request.amount, currency: request.currency },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toRecordPaymentError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
  Layer.effect(
    RecordPaymentFailure,
    Effect.gen(function* () {
      const client = yield* BillingAdminApi.Client;
      const options = callOptionsOf(yield* Effect.serviceOption(BindingCall));
      return Effect.fn("Paykit.RecordPaymentFailure")(function* (account) {
        return Effect.fn("Paykit.RecordPaymentFailure.record")(function* (request) {
          const receipt = yield* bound(toRecordPaymentFailureError)(
            client.RecordPaymentFailure(
              account,
              { reason: request.reason, graceUntil: request.graceUntil },
              options(request.dedupeKey),
            ),
          );
          const view = yield* bound(toRecordPaymentFailureError)(
            client.BillingState.get(account, { atLeast: receipt, ...options() }),
          );
          return standingSnapshot(view);
        });
      });
    }),
  ),
);
