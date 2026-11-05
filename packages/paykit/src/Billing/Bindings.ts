import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A binding could not reach the model at all: the transport failed, the reply did
 * not decode, or the call was not authenticated.
 *
 * This is deliberately **not** a rejection. A rejection is a command the model
 * understood and refused, so the write did not happen and a caller may correct
 * the request. A `BindingFailed` means we do not know whether the write landed,
 * so a retry must carry the same `dedupeKey` rather than be treated as a new
 * attempt. Folding the two together would turn "no charge" and "unknown charge"
 * into one answer about money.
 *
 * @primitive
 */
export class BindingFailed extends Schema.TaggedError<BindingFailed>()("BindingFailed", {
  /** The binding that failed, e.g. `Paykit.TrackUsage`. */
  binding: Schema.String,
  /** What the transport or the decoder said, for an operator to read. */
  message: Schema.String,
}) {}

/**
 * How a binding authenticates the call it makes to a *remote* paykit surface.
 *
 * A binding that runs in the same process as the model needs nothing: it sends
 * as the system actor, because the deployment already authenticated the work. A
 * binding that talks to another service needs the caller's own credentials, and
 * those belong to the deployment — a cookie, a bearer token, a signed header —
 * not to this package. Provide this service beside the Api-client protocol and
 * every outbound call carries it.
 *
 * Absent, a remote binding sends no credentials, which is correct for an Api
 * served behind a signature at the edge or in a test.
 *
 * ### Carrying a session to a remote surface
 * **Example:** Provide the caller's cookie to every binding call
 * ```typescript
 * const Caller = Layer.succeed(BindingCall, { headers: { authorization: token } });
 *
 * yield* trackUsage({ feature: "messages", amount: 1, dedupeKey: requestId }).pipe(
 *   Effect.provide(Caller),
 * );
 * ```
 *
 * @primitive
 */
export class BindingCall extends Context.Service<
  BindingCall,
  { readonly headers?: Headers.Input }
>()("paykit/BindingCall") {}

/**
 * Everything a binding can fail with: the model's refusal, a write whose read
 * landed late, or a binding that never reached the model. Keeping them apart is
 * the point — only the first says the charge did not happen.
 */
export type BindingError<Refusal> = Refusal | Domain.ConsistencyTimeout | BindingFailed;

/**
 * A guard that narrows an unknown failure to the refusals one command declares.
 * The list is the schema list, so the type and the runtime check cannot drift.
 */
export const oneOf =
  <E>(schemas: ReadonlyArray<Schema.Constraint>) =>
  (error: unknown): error is E =>
    schemas.some((schema) => Schema.is(schema)(error));

/**
 * A layer's own failure, as the one union its binding declares. A transport's
 * error becomes `BindingFailed`; a write whose read landed late stays
 * `ConsistencyTimeout`, because the charge did happen and a caller must not
 * read it as "nothing was written".
 */
export const mapBindingFailure =
  <E>(map: (error: unknown) => E) =>
  <A, R, K>(effect: Effect.Effect<A, K, R>): Effect.Effect<A, E, R> =>
    Effect.mapError(effect, map);

export const toBindingError =
  <E>(binding: string, known: (error: unknown) => error is E) =>
  (error: unknown): BindingError<E> =>
    Schema.is(Domain.ConsistencyTimeout)(error) || known(error)
      ? error
      : new BindingFailed({ binding, message: transportMessage(error) });

/**
 * The per-call options an outbound Api call carries: the deployment's headers,
 * when it provides {@link BindingCall}, plus the command id a retry reuses.
 *
 * Resolved once, when the layer is built — the same rule every other service in
 * this package follows — so a verb never reads a service to authenticate itself.
 */
export const callOptionsOf = (call: Option.Option<{ readonly headers?: Headers.Input }>) => {
  const headers = Option.isNone(call) ? {} : { headers: call.value.headers };
  return (commandId?: string) => (commandId === undefined ? headers : { commandId, ...headers });
};

/** The outcome of a command that no model reply can describe: the transport's. */
export const transportMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const tag = (error as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : String(error);
};
