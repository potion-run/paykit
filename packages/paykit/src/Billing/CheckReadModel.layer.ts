import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BillingReadStore } from "../BillingReadStore.ts";
import { CheckFailed, evaluateCheck, rowToState } from "../Check.ts";
import { EntityId } from "../Customer.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { mapBindingFailure } from "./Bindings.ts";
import { Check, toCheckError } from "./Check.binding.ts";

/**
 * `Check` over the edge read model: one row from `billing_rm_*`, no event fold
 * and no view to resolve. This is the path a request at the edge takes when the
 * model lives somewhere else, and it answers exactly what `evaluateCheck` answers
 * — the same function, so the paths cannot disagree about a verdict.
 *
 * Provide it beside `SqlBillingReadStore`. A deployment that hosts the model uses
 * `BillingInProcess` instead; a process that reads a replica uses this one; a
 * caller that crosses a service boundary uses `CheckOverTransport`.
 *
 * @layer
 * @product Usage
 * @provides Paykit.Check
 */
export const CheckReadModel = Layer.effect(
  Check,
  Effect.gen(function* () {
    const store = yield* BillingReadStore;

    return Effect.fn("Paykit.Check")(function* (account) {
      return Effect.fn("Paykit.Check.readModel")(function* (request) {
        // The edge reads a row; it does not own the aggregate, so it cannot
        // place a lock. A deployment that needs one uses `BillingInProcess`.
        if (request.lock === true) {
          return yield* mapBindingFailure(toCheckError)(
            Effect.fail(
              new CheckFailed({ message: "a lock needs the model, which this read does not own" }),
            ),
          );
        }

        const row = yield* mapBindingFailure(toCheckError)(store.get(account));

        if (request.entityId !== undefined) {
          const entity = row?.entities?.[request.entityId];

          // An archived scope answers `allowed: false`; an id this customer
          // never attached is a refusal, not an empty scope (ADR 0040 §4).
          if (entity === undefined) {
            return yield* mapBindingFailure(toCheckError)(
              Effect.fail(
                new EntityUnknown({ account, entityId: EntityId.make(request.entityId) }),
              ),
            );
          }

          return evaluateCheck(row === null ? null : rowToState(row, request.entityId), {
            account,
            ...request,
          });
        }

        return evaluateCheck(row === null ? null : rowToState(row), { account, ...request });
      });
    });
  }),
);
