import type * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Balance, balanceOfScope, balancesOfScope, emptyBalance } from "../Balance.ts";
import { CUSTOMER_SCOPE, type EntityId, entityScope } from "../Customer.ts";
import type { EntitlementsState } from "../Subscription/Entitlements.view.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import {
  BalanceNotFound,
  Balances,
  type BalancesError,
  toBalancesError,
} from "./Balances.binding.ts";
import {
  type BindingFailed,
  mapBindingFailure,
  oneOf,
  type ReceiptRef,
  toBindingError,
} from "./Bindings.ts";
import { GrantBalance } from "./GrantBalance.binding.ts";
import { ReleaseHold } from "./ReleaseHold.binding.ts";
import { SettleHold } from "./SettleHold.binding.ts";
import { SetUsage } from "./SetUsage.binding.ts";

/**
 * The read a `Balances` verb answers from: one account's entitlement view. It
 * exists so the binding composes once — the in-process layer reads the view,
 * the Api layer reads the same view over its client — instead of being written
 * twice and drifting.
 *
 * @primitive
 */
export class BalancesRead extends Context.Service<
  BalancesRead,
  {
    readonly view: (
      account: string,
      atLeast?: ReceiptRef,
    ) => Effect.Effect<EntitlementsState | null, Domain.ConsistencyTimeout | BindingFailed>;
  }
>()("paykit/BalancesRead") {}

/** A read failure, narrowed the way every binding narrows its transport. */
const isBalancesReadRefusal = oneOf<never>([]);

export const toBalancesReadError = toBindingError("Paykit.Balances.read", isBalancesReadRefusal);

/** A scope a caller named, or `EntityUnknown` when this customer never created it. */
const knownScope = (
  state: EntitlementsState | null,
  account: string,
  entityId: EntityId | undefined,
): Effect.Effect<void, BalancesError> =>
  entityId !== undefined && state?.entities?.[entityId] === undefined
    ? Effect.fail(new EntityUnknown({ account, entityId }))
    : Effect.void;

/**
 * The balances surface, composed from the commands that already exist: a read
 * of the entitlement view, `SetUsage` for occupancy, and `SettleHold` /
 * `ReleaseHold` for a lock. It adds no second model and no second write path.
 *
 * @layer
 * @product Usage
 * @provides Paykit.Balances
 */
export const BalancesLive = Layer.effect(
  Balances,
  Effect.gen(function* () {
    const read = yield* BalancesRead;
    const grantBalance = yield* GrantBalance;
    const setUsage = yield* SetUsage;
    const settleHold = yield* SettleHold;
    const releaseHold = yield* ReleaseHold;

    const viewOf = (account: string) => mapBindingFailure(toBalancesError)(read.view(account));

    const balanceOfView = (
      state: EntitlementsState | null,
      account: string,
      featureId: string,
      entityId: EntityId | undefined,
    ): Effect.Effect<Balance, BalancesError> => {
      const balance = state === null ? null : balanceOfScope(state, featureId, entityId);

      return balance === null
        ? Effect.fail(new BalanceNotFound({ customerId: account, featureId }))
        : Effect.succeed(balance);
    };

    return Effect.fn("Paykit.Balances")(function* (account) {
      return {
        list: Effect.fn("Paykit.Balances.list")(function* (request) {
          const state = yield* viewOf(account);
          const entityId = request?.entityId;

          yield* knownScope(state, account, entityId);

          return state === null ? [] : balancesOfScope(state, entityId);
        }),
        get: Effect.fn("Paykit.Balances.get")(function* (request) {
          const state = yield* viewOf(account);

          yield* knownScope(state, account, request.entityId);

          return yield* balanceOfView(state, account, request.featureId, request.entityId);
        }),
        create: Effect.fn("Paykit.Balances.create")(function* (request) {
          // `reset` is the public spelling of a lifetime grant; the command has
          // no reset schedule. A resetting standalone grant is an add-on plan
          // item (Phase 5).
          const grant = yield* grantBalance(account);

          const result = yield* grant({
            featureId: request.featureId,
            granted: request.grantedBalance,
            ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
            ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
            ...(request.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: request.idempotencyKey }),
          });

          return result.balance;
        }),
        update: Effect.fn("Paykit.Balances.update")(function* (request) {
          const set = yield* setUsage(account);

          const result = yield* set({
            featureId: request.featureId,
            usage: request.usage,
            ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
            ...(request.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: request.idempotencyKey }),
          });

          // The write answered with the balance it waited for. Reading the view
          // again would race the projection and could report the previous write.
          return result.balance;
        }),
        finalize: Effect.fn("Paykit.Balances.finalize")(function* (request) {
          if (request.entityId !== undefined) {
            const before = yield* viewOf(account);

            yield* knownScope(before, account, request.entityId);
          }

          const settled =
            request.action === "commit"
              ? yield* (yield* settleHold(account))({
                  holdId: request.lockId,
                  ...(request.overrideValue === undefined ? {} : { amount: request.overrideValue }),
                  dedupeKey: `${request.lockId}:settle`,
                })
              : null;

          const released =
            settled === null
              ? yield* (yield* releaseHold(account))({
                  holdId: request.lockId,
                  dedupeKey: `${request.lockId}:release`,
                })
              : null;

          // A lock is a customer fact; the entity id names the scope the answer
          // is read from, not a second hold stream.
          if (request.entityId === undefined) {
            return settled === null ? released!.balance : settled.balance;
          }

          const state = yield* viewOf(account);
          const featureId = settled === null ? released!.featureId : settled.featureId;

          return (
            (state === null ? null : balanceOfScope(state, featureId, request.entityId)) ??
            emptyBalance(
              account,
              featureId,
              request.entityId === undefined ? CUSTOMER_SCOPE : entityScope(request.entityId),
            )
          );
        }),
      };
    });
  }),
);
