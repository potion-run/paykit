import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { asSystem } from "../Auth/Actor.ts";
import { BillingState } from "../Subscription/BillingState.view.ts";
import { EnterGrace as EnterGraceCommand } from "../Subscription/EnterGrace.command.ts";
import { Expire as ExpireCommand } from "../Subscription/Expire.command.ts";
import { ExtendTrial as ExtendTrialCommand } from "../Subscription/ExtendTrial.command.ts";
import { GrantCredits as GrantCreditsCommand } from "../Subscription/GrantCredits.command.ts";
import { RecordPayment as RecordPaymentCommand } from "../Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure as RecordPaymentFailureCommand } from "../Subscription/RecordPaymentFailure.command.ts";
import { Recover as RecoverCommand } from "../Subscription/Recover.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
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
import { mapBindingFailure } from "./Bindings.ts";

/** A layer's own failure, as the union its binding declares. */
const bound = mapBindingFailure;

/**
 * Every operator binding, implemented in the process that hosts the model.
 *
 * A **separate layer** from `BillingInProcess` on purpose: clearance is the
 * layer, so a deployment that provides this one has handed the operator commands
 * out, and a deployment that provides the tenant layer has not. The Api client
 * path is `BillingAdminApiLayer`; nothing at a call site changes.
 *
 * Sends as the system actor, because the console that provides this layer has
 * already authenticated the operator — the deployment owns who may reach it.
 *
 * ### Providing the ops console
 * **Example:** A console backend beside its tenant Worker
 * ```typescript
 * const Ops = Layer.mergeAll(BillingAdminInProcess, catalogLayer(Catalog));
 *
 * yield* (yield* Paykit.GrantCredits(account))({ amount: 250, dedupeKey: ticketId });
 * ```
 *
 * @layer
 * @product Console
 * @provides Paykit.GrantCredits
 */
export const BillingAdminInProcess = Layer.mergeAll(
  Layer.effect(
    GrantCredits,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      return Effect.fn("Paykit.GrantCredits")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.GrantCredits.add")(function* (request) {
          const receipt = yield* bound(toGrantCreditsError)(
            asSystem(
              subscription.send(ref, new GrantCreditsCommand({ amount: request.amount }), {
                commandId: request.dedupeKey,
              }),
            ),
          );
          return receipt.reply;
        });
      });
    }),
  ),
  Layer.effect(
    ExtendTrial,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.ExtendTrial")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.ExtendTrial.extend")(function* (request) {
          const receipt = yield* bound(toExtendTrialError)(
            asSystem(
              subscription.send(ref, new ExtendTrialCommand({ trialEndsAt: request.trialEndsAt }), {
                commandId: request.dedupeKey,
              }),
            ),
          );
          const view = yield* bound(toExtendTrialError)(billing.query(ref, { atLeast: receipt }));
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
  Layer.effect(
    EnterGrace,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.EnterGrace")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.EnterGrace.open")(function* (request) {
          const receipt = yield* bound(toEnterGraceError)(
            asSystem(
              subscription.send(ref, new EnterGraceCommand({ graceUntil: request.graceUntil }), {
                commandId: request.dedupeKey,
              }),
            ),
          );
          const view = yield* bound(toEnterGraceError)(billing.query(ref, { atLeast: receipt }));
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
  Layer.effect(
    Recover,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.Recover")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.Recover.standing")(function* (request) {
          const receipt = yield* bound(toRecoverError)(
            asSystem(
              subscription.send(ref, new RecoverCommand(), { commandId: request.dedupeKey }),
            ),
          );
          const view = yield* bound(toRecoverError)(billing.query(ref, { atLeast: receipt }));
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
  Layer.effect(
    Expire,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.Expire")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.Expire.standing")(function* (request) {
          const receipt = yield* bound(toExpireError)(
            asSystem(subscription.send(ref, new ExpireCommand(), { commandId: request.dedupeKey })),
          );
          const view = yield* bound(toExpireError)(billing.query(ref, { atLeast: receipt }));
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
  Layer.effect(
    RecordPayment,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.RecordPayment")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.RecordPayment.record")(function* (request) {
          const receipt = yield* bound(toRecordPaymentError)(
            asSystem(
              subscription.send(
                ref,
                new RecordPaymentCommand({ amount: request.amount, currency: request.currency }),
                { commandId: request.dedupeKey },
              ),
            ),
          );
          const view = yield* bound(toRecordPaymentError)(billing.query(ref, { atLeast: receipt }));
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
  Layer.effect(
    RecordPaymentFailure,
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const billing = yield* BillingState;
      return Effect.fn("Paykit.RecordPaymentFailure")(function* (account) {
        const ref = Subscription.ref(account);
        return Effect.fn("Paykit.RecordPaymentFailure.record")(function* (request) {
          const receipt = yield* bound(toRecordPaymentFailureError)(
            asSystem(
              subscription.send(
                ref,
                new RecordPaymentFailureCommand({
                  reason: request.reason,
                  graceUntil: request.graceUntil,
                }),
                { commandId: request.dedupeKey },
              ),
            ),
          );
          const view = yield* bound(toRecordPaymentFailureError)(
            billing.query(ref, { atLeast: receipt }),
          );
          return standingSnapshot(Option.getOrNull(view));
        });
      });
    }),
  ),
);
