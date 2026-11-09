import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";
import type { PreviewCommand, PreviewResult } from "./Preview.operation.ts";

/**
 * What to decide without recording. The account is the bind, so a caller names
 * only the action.
 */
export interface PreviewRequest {
  /** The command to run in the model's pure `decide` and throw away. */
  readonly command: PreviewCommand;
}

const refusals = [PlanNotInCatalog, Unauthenticated, Forbidden] as const;

/**
 * Every refusal a preview can answer. A *model* refusal — an allowance too
 * small, a ceiling already passed — is data in the result, not a failure; what
 * is here is a name the catalog does not carry, which the preview cannot even
 * turn into a command.
 */
export type PreviewRefusal = InstanceType<(typeof refusals)[number]>;

export type PreviewError = BindingError<PreviewRefusal>;

/** Whether a failure is `Preview` refusing the caller. */
export const isPreviewRefusal = oneOf<PreviewRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toPreviewError = toBindingError("Paykit.Preview", isPreviewRefusal);

/** The verb of a bound `Preview`. */
export type PreviewVerb = (request: PreviewRequest) => Effect.Effect<PreviewResult, PreviewError>;

/**
 * Run the model's pure `decide` and report what a command would produce: the
 * events, the state after them, and the proration it would charge. Nothing is
 * recorded, and the answer cannot disagree with the write it previews because
 * it is the same function.
 *
 * A model refusal comes back as `_tag: "rejected"` — data, not a failure — so a
 * console or an agent can show *why* before anyone sends anything.
 *
 * ### Showing the charge first
 * **Example:** Quote an upgrade
 * ```typescript
 * const preview = yield* Paykit.Preview(account);
 * const answer = yield* preview({ command: { kind: "changeTier", tier: "scale" } });
 * if (answer._tag === "accepted" && answer.proration !== undefined) show(answer.proration.due);
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Preview
 */
export interface Preview extends Binding.Service<
  Preview,
  "Paykit.Preview",
  (account: string) => Effect.Effect<PreviewVerb>
> {}

export const Preview = Binding.Service<Preview>("Paykit.Preview");
