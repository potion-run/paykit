import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asSystem } from "../Auth/Actor.ts";
import { Payments, PaymentsRouter, ProviderCapabilityMissing, providerFor } from "../Payments.ts";
import { DunningRetry, DunningRetryDue } from "./DunningRetry.command.ts";
import { GraceEntered } from "./EnterGrace.command.ts";
import { GraceElapsed } from "./GraceElapsed.command.ts";
import { RecordPayment } from "./RecordPayment.command.ts";
import { PaymentFailed, RecordPaymentFailure } from "./RecordPaymentFailure.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { priceOf } from "./Subscription.state.ts";

/**
 * The times, measured from the first failure of a dunning run, at which the
 * policy retries. `[1 day, 3 days, 7 days]` is three attempts; a failure with
 * no entry left is the last one, and grace expires at the standing's deadline.
 */
export interface DunningTerms {
  readonly retries: ReadonlyArray<Duration.Duration>;
}

/** A deployment's retry ladder has an entry that is not a positive duration. */
export class DunningInvalid extends Schema.TaggedError<DunningInvalid>()("DunningInvalid", {
  /** The position in `retries` that is wrong. */
  index: Schema.Int,
  reason: Schema.Literals(["not-positive"]),
}) {}

/** The ladder `Paykit.dunning` resolved once, for the policy to read. */
export class DunningConfig extends Context.Service<DunningConfig, DunningTerms>()(
  "paykit/Dunning",
) {}

/**
 * Turn on a dunning retry ladder. Without this layer the policy still owns
 * grace and expiry, but it never charges a saved method; the vendor's own
 * retries are the only attempts, exactly as before.
 *
 * Each entry is measured from the first failure of the run, not from the
 * preceding attempt, so a late policy run does not move the rest of the ladder.
 * A retry at or after the standing's `graceUntil` is not scheduled: the grace
 * deadline remains the hard stop. The retry is made against the account's saved
 * method through `Payments.charge` and is keyed by the run and the attempt, so
 * a redelivered policy run is the charge it already took. A deployment that
 * turns this on should turn the vendor's own dunning off, or both schedules
 * will attempt the same collection.
 *
 * ### Retrying a declined card three times
 * **Example:** A day, then three days, then a week
 * ```typescript
 * const layer = Paykit.ModelHandlers.pipe(
 *   Layer.provideMerge(Paykit.paymentsRouter(provider)),
 *   Layer.provideMerge(
 *     Paykit.dunning({
 *       retries: [Duration.days(1), Duration.days(3), Duration.days(7)],
 *     }).pipe(Layer.orDie),
 *   ),
 * );
 * ```
 *
 * @layer
 */
export const dunning = (options: DunningTerms): Layer.Layer<DunningConfig, DunningInvalid> =>
  Layer.effect(
    DunningConfig,
    Effect.gen(function* () {
      for (const [index, retry] of options.retries.entries()) {
        const millis = Duration.toMillis(retry);

        if (!Number.isFinite(millis) || millis <= 0) {
          return yield* new DunningInvalid({ index, reason: "not-positive" });
        }
      }

      return { retries: options.retries };
    }),
  );

/**
 * The id of one rung: a run and the failure it follows identify the attempt,
 * so an old schedule cannot fire against the next dunning run.
 */
export const dunningRetryCommandId = (
  account: string,
  startedAt: DateTime.Utc,
  afterAttempt: number,
): string => `dunning-retry:${account}:${DateTime.toEpochMillis(startedAt)}:${afterAttempt}`;

/** The id of the charge one rung makes, stable across a policy redelivery. */
export const dunningChargeCommandId = (
  account: string,
  startedAt: DateTime.Utc,
  attempt: number,
): string => `dunning-charge:${account}:${DateTime.toEpochMillis(startedAt)}:${attempt}`;

const paymentCommandId = (account: string, startedAt: DateTime.Utc, attempt: number): string =>
  `dunning-payment:${account}:${DateTime.toEpochMillis(startedAt)}:${attempt}`;

const failureCommandId = (account: string, startedAt: DateTime.Utc, attempt: number): string =>
  `dunning-failed:${account}:${DateTime.toEpochMillis(startedAt)}:${attempt}`;

/**
 * Whenever an account enters grace, schedule the deadline that expires it and
 * the retry rungs the deployment configured. A recovery before then leaves
 * both to fire as no-ops.
 *
 * The ladder is written from the standing, not from the policy's clock: the
 * first failure's instant is on `PaymentFailed`, so a redelivered event
 * derives the same rungs and a later failure does not move the ones already
 * scheduled. A retry that is handled after grace passed records nothing; the
 * expiry is what acts then.
 */
export class Dunning extends Domain.Policy("Dunning", {
  from: Subscription,
  on: [PaymentFailed, GraceEntered, DunningRetryDue],
}) {}

export const DunningLive = Dunning.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    const config = Option.getOrNull(yield* Effect.serviceOption(DunningConfig));

    // A deployment that asked for retries needs a provider to charge. Resolve
    // the router while the layer is built, like every policy that calls one.
    const router = Option.getOrNull(yield* Effect.serviceOption(PaymentsRouter));

    if (config !== null && router === null) {
      return yield* Effect.die(new ProviderCapabilityMissing({ provider: "none", op: "charge" }));
    }

    return Effect.fn("Paykit.Dunning.react")(function* ({ key, event }) {
      const standing = yield* subscriptions.state(key);

      if (standing._tag !== "Subscribed") return;

      if (event._tag === "DunningRetryDue") {
        if (router === null) return;

        if (standing.status !== "grace" || standing.graceUntil === undefined) return;
        const graceUntil = standing.graceUntil;

        if (standing.dunningStartedAt === undefined) return;

        if (
          DateTime.toEpochMillis(standing.dunningStartedAt) !==
          DateTime.toEpochMillis(event.startedAt)
        ) {
          return;
        }

        if (standing.dunningAttempts + 1 !== event.attempt) return;

        const chosen = providerFor(router, standing.refs);

        if (chosen === null || !chosen.capabilities.has("charge")) {
          return yield* Effect.die(
            new ProviderCapabilityMissing({ provider: chosen?.name ?? "none", op: "charge" }),
          );
        }

        const charge = Effect.gen(function* () {
          const payments = yield* Payments;

          return yield* payments.charge({
            account: key.id,
            amount: event.amount,
            currency: event.currency,
            commandId: dunningChargeCommandId(key.id, event.startedAt, event.attempt),
          });
        }).pipe(Effect.provide(chosen.payments));

        yield* charge.pipe(
          Effect.flatMap(() =>
            asSystem(
              subscriptions.send(
                key,
                new RecordPayment({ amount: event.amount, currency: event.currency }),
                { commandId: paymentCommandId(key.id, event.startedAt, event.attempt) },
              ),
            ).pipe(Effect.catchTag("NotInGrace", () => Effect.void)),
          ),
          Effect.catchTags({
            PaymentDeclined: (declined) =>
              asSystem(
                subscriptions.send(
                  key,
                  new RecordPaymentFailure({
                    reason: declined.code,
                    graceUntil,
                  }),
                  { commandId: failureCommandId(key.id, event.startedAt, event.attempt) },
                ),
              ).pipe(Effect.asVoid),
            ProviderCapabilityMissing: (missing) => Effect.die(missing),
          }),
        );

        return;
      }

      if (standing.status !== "grace" || standing.graceUntil === undefined) return;

      yield* subscriptions
        .schedule(key, new GraceElapsed(), {
          at: standing.graceUntil,
          commandId: `grace-elapsed:${standing.graceUntil.epochMilliseconds}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));

      if (config === null || event._tag !== "PaymentFailed") return;
      const startedAt = standing.dunningStartedAt;

      if (startedAt === undefined || priceOf(standing) === undefined) return;

      const graceMillis = DateTime.toEpochMillis(standing.graceUntil);

      for (let index = standing.dunningAttempts - 1; index < config.retries.length; index++) {
        const retry = config.retries[index];

        if (retry === undefined) continue;
        const retryAt = DateTime.addDuration(startedAt, retry);

        // A rung at or past the deadline is not a retry; `GraceElapsed` acts there.
        if (DateTime.toEpochMillis(retryAt) >= graceMillis) continue;
        const afterAttempt = index + 1;
        yield* subscriptions
          .schedule(key, new DunningRetry({ afterAttempt, startedAt }), {
            at: retryAt,
            commandId: dunningRetryCommandId(key.id, startedAt, afterAttempt),
          })
          .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
      }
    });
  }),
);
