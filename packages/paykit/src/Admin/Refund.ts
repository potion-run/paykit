import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { Refund as RefundBinding } from "../Billing/Admin.binding.ts";
import { transportMessage } from "../Billing/Bindings.ts";
import { PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import { RefundExceedsCharged } from "../Subscription/Refund.command.ts";
import { AdminReadError, AdminReadFailed } from "./Reads.ts";

/**
 * A refund an operator asks the console's server to take. The server owns the
 * provider, so the browser names the charge and the amount; the binding checks
 * the ceiling and takes the money before the command records it.
 */
export const RefundRequest = Schema.Struct({
  account: Schema.String,
  /** The provider's reference for the charge being refunded. */
  chargeId: Schema.String,
  /** Minor units. A non-positive amount records nothing; too much is refused. */
  amount: Schema.Int,
  currency: Schema.String,
  /** Why the money went back, as an operator would tell a customer. */
  reason: Schema.optionalKey(Schema.String),
  /**
   * The retry key, which is the provider's idempotency key and the command id.
   * The server allocates one when absent; the console always sends its own so
   * a retry replays the same refund.
   */
  commandId: Schema.optionalKey(Schema.String),
});

export type RefundRequest = typeof RefundRequest.Type;

/** Every typed refusal a refund can return as data. */
export const RefundRejection = Schema.Union([
  RefundExceedsCharged,
  ProviderCapabilityMissing,
  PaymentDeclined,
]);

export type RefundRejection = typeof RefundRejection.Type;

/** The provider took the money and the log recorded it. */
export const RefundApplied = Schema.TaggedStruct("applied", {
  commandId: Schema.String,
  /** The provider's id for the refund it took. */
  refundId: Schema.String,
  /** Minor units refunded in this currency so far, as the event recorded it. */
  refunded: Schema.Int,
  currency: Schema.String,
});

/** A typed refusal: the ceiling before the provider, or the provider's decline. */
export const RefundRejected = Schema.TaggedStruct("rejected", {
  commandId: Schema.optionalKey(Schema.String),
  rejection: RefundRejection,
});

/** The outcome is unknown, so the command id is safe to retry. */
export const RefundFailed = Schema.TaggedStruct("failed", {
  commandId: Schema.optionalKey(Schema.String),
  reason: Schema.String,
});

export const RefundAnswer = Schema.Union([RefundApplied, RefundRejected, RefundFailed]);

export type RefundAnswer = typeof RefundAnswer.Type;

/** The server-side refund: the in-process binding, with the answer as data. */
export interface AdminRefundShape {
  readonly refund: (input: RefundRequest) => Effect.Effect<RefundAnswer, AdminReadError>;
}

/**
 * The refund port the console's server exposes. It runs the in-process
 * `Paykit.Refund` binding, so the process that serves the console is the one
 * that holds the provider: `BillingAdminApiLayer` deliberately has no refund,
 * because an Api backend that cannot reach the provider must not take money
 * out. The binding checks the ceiling before the provider call, so a refund
 * the model would refuse never leaves the account.
 *
 * ### Refunding from the console server
 * **Example:** The Worker that owns the provider
 * ```typescript
 * // `AdminConsoleServer` builds this port from `Paykit.Refund`; a route beside
 * // the console can also provide `AdminRefundLive` and call it directly.
 * const refund = yield* AdminRefund;
 * const answer = yield* refund.refund({
 *   account: "acct_1",
 *   chargeId: "ch_123",
 *   amount: 1900,
 *   currency: "usd",
 *   commandId: ticketId,
 * });
 * ```
 *
 * @primitive
 */
export class AdminRefund extends Context.Service<AdminRefund, AdminRefundShape>()(
  "paykit/AdminRefund",
) {}

export const makeAdminRefund = Effect.gen(function* () {
  const refund = yield* RefundBinding;

  return {
    refund: (input) =>
      Effect.gen(function* () {
        const commandId =
          input.commandId ?? (yield* Effect.sync(() => globalThis.crypto.randomUUID()));

        const verb = yield* refund(input.account);

        const result = yield* Effect.result(
          verb({
            chargeId: input.chargeId,
            amount: input.amount,
            currency: input.currency,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            dedupeKey: commandId,
          }),
        );

        if (Result.isSuccess(result)) {
          return RefundApplied.make({
            commandId,
            refundId: result.success.refundId,
            refunded: result.success.refunded,
            currency: result.success.currency,
          });
        }

        if (Schema.is(RefundRejection)(result.failure)) {
          return RefundRejected.make({ commandId, rejection: result.failure });
        }

        // A transport failure is not a refusal: the money may have moved, so
        // the console keeps the command id and offers the retry.
        return RefundFailed.make({
          commandId,
          reason: transportMessage(result.failure),
        });
      }),
  } satisfies AdminRefundShape;
});

/** The in-process refund port, as one Layer. */
export const AdminRefundLive = Layer.effect(AdminRefund, makeAdminRefund);

/**
 * The money-moving half of the console's server surface. It is separate from
 * `AdminReadsRpcs` and `AdminChangeTierRpcs` because it needs the provider,
 * which the Api layer does not have.
 */
export const AdminRefundRpcs = RpcGroup.make(
  Rpc.make("Refund", {
    payload: RefundRequest,
    success: RefundAnswer,
    error: AdminReadError,
  }),
).middleware(Admin);

export const AdminRefundHandlers = Effect.map(makeAdminRefund, (refund) =>
  AdminRefundRpcs.of({
    Refund: (input: RefundRequest) => refund.refund(input),
  }),
);

const transportFailure = (error: RpcClientError.RpcClientError): AdminReadFailed =>
  new AdminReadFailed({ reason: error.reason._tag, message: error.message });

/**
 * The browser/Worker client for the refund RPC. It shares the console's
 * endpoint with `AdminReadsClient` and `AdminChangeTierClient`; the merged
 * server group dispatches by tag.
 *
 * @layer
 */
export const AdminRefundClient = (
  url: string,
  options: {
    readonly headers?: Headers.Input;
    readonly transformClient?: <E, R>(
      client: HttpClient.HttpClient.With<E, R>,
    ) => HttpClient.HttpClient.With<E, R>;
  } = {},
): Layer.Layer<AdminRefund, never, HttpClient.HttpClient> =>
  Layer.effect(
    AdminRefund,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AdminRefundRpcs);

      const call = <A>(
        effect: Effect.Effect<A, AdminReadError | RpcClientError.RpcClientError>,
      ): Effect.Effect<A, AdminReadError> =>
        (options.headers === undefined
          ? effect
          : RpcClient.withHeaders(effect, options.headers)
        ).pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(transportFailure(error))));

      return {
        refund: (input) => call(client.Refund(input)),
      } satisfies AdminRefundShape;
    }),
  ).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url,
        ...(options.transformClient === undefined
          ? {}
          : { transformClient: options.transformClient }),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  );
