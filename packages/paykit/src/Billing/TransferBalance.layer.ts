import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { balanceOfScope, emptyBalance, type Balance } from "../Balance.ts";
import { scopeEntityId, type ScopeRef } from "../Customer.ts";
import type { EntitlementsState } from "../Subscription/Entitlements.view.ts";
import { BalancesRead } from "./Balances.layer.ts";
import { mapBindingFailure, type ReceiptRef } from "./Bindings.ts";
import {
  TransferBalance,
  type TransferBalanceError,
  type TransferBalanceRequest,
  type TransferBalanceResult,
  toTransferBalanceError,
} from "./TransferBalance.binding.ts";

/**
 * The one write a transfer makes. A layer implements the send and answers the
 * receipt; the binding reads the entitlement view it waited for, so both
 * transports report the balances a caller's next read sees.
 *
 * @primitive
 */
export class TransferBalanceWrite extends Context.Service<
  TransferBalanceWrite,
  {
    readonly transfer: (
      account: string,
      request: TransferBalanceRequest,
    ) => Effect.Effect<ReceiptRef, TransferBalanceError>;
  }
>()("paykit/TransferBalanceWrite") {}

/** One scope's balance from a committed view, or the empty balance a blocked read gives. */
const balanceOf = (
  state: EntitlementsState | null,
  account: string,
  featureId: string,
  scope: ScopeRef,
): Balance =>
  (state === null ? null : balanceOfScope(state, featureId, scopeEntityId(scope))) ??
  emptyBalance(account, featureId, scope);

/**
 * The transfer verb: one command, then the entitlement view it waited for. The
 * two balances are read from the committed view rather than rebuilt from the
 * reply, so `fromAfter`/`toAfter` on the event and the numbers a caller reads
 * cannot disagree.
 *
 * @layer
 * @product Entities
 * @provides Paykit.TransferBalance
 */
export const TransferBalanceLive = Layer.effect(
  TransferBalance,
  Effect.gen(function* () {
    const write = yield* TransferBalanceWrite;
    const read = yield* BalancesRead;

    return Effect.fn("Paykit.TransferBalance")(function* (account) {
      return Effect.fn("Paykit.TransferBalance.move")(function* (request) {
        const receipt = yield* write.transfer(account, request);

        const view = yield* mapBindingFailure(toTransferBalanceError)(read.view(account, receipt));

        return {
          amount: request.amount,
          from: balanceOf(view, account, request.featureId, request.from),
          to: balanceOf(view, account, request.featureId, request.to),
        } satisfies TransferBalanceResult;
      });
    });
  }),
);
