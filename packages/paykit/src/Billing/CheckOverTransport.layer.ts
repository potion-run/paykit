import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CheckTransport } from "../Check.ts";
import { mapBindingFailure } from "./Bindings.ts";
import { Check, toCheckError } from "./Check.binding.ts";

/**
 * `Check` over a transport: delegate the question to whatever serves the
 * entitlement elsewhere — an HTTP call, a Durable Object, another Worker's
 * binding. The deployment provides {@link CheckTransport}, so this layer holds no
 * opinion about how the answer travels.
 *
 * The transport answers `CheckResult` already, so no `evaluateCheck` runs here:
 * the remote side made the judgement with the same function and the same view.
 *
 * @layer
 * @product Usage
 * @provides Paykit.Check
 */
export const CheckOverTransport = Layer.effect(
  Check,
  Effect.gen(function* () {
    const transport = yield* CheckTransport;
    return Effect.fn("Paykit.Check")(function* (account) {
      return Effect.fn("Paykit.Check.transport")(function* (request) {
        return yield* mapBindingFailure(toCheckError)(transport.check({ account, ...request }));
      });
    });
  }),
);
