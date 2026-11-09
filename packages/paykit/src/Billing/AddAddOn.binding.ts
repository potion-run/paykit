import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Allowance } from "../Allowance.ts";
import { planOf } from "../Catalog.ts";
import { CatalogService } from "../CatalogService.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import type { ChangeTierVerb } from "./ChangeTier.binding.ts";
import { ChangeTier } from "./ChangeTier.binding.ts";
import { PlanOperationUnsupported } from "./PlanOperationUnsupported.ts";
import type { ChargeProrationVerb } from "./Portal.binding.ts";
import { ChargeProration } from "./Portal.binding.ts";

/** What a caller asks `addAddOn` to buy. */
export const AddAddOnRequest = Schema.Struct({
  /** The add-on plan the catalog declares with `addOn: true`. */
  planId: Schema.String,
  /**
   * The plan items a custom add-on is sold with, when they differ from the
   * catalog's defaults (ADR 0041).
   */
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  /** The retry key, which is also the command id. */
  idempotencyKey: Schema.String,
});

export type AddAddOnRequest = typeof AddAddOnRequest.Type;

/** What adding an add-on did. */
export interface AddAddOnResult {
  readonly outcome: "added";
  readonly planId: string;
}

/** The verb of a bound `AddAddOn`. */
export type AddAddOnVerb = (
  request: AddAddOnRequest,
) => Effect.Effect<AddAddOnResult, AddAddOnError>;

/** Everything `addAddOn` can fail with, inferred from the move it composes. */
export type AddAddOnError = Effect.Error<ReturnType<typeof addAddOnWith>>;

const addAddOnWith = Effect.fn("Paykit.AddAddOn.add")(function* (
  catalog: Parameters<typeof planOf>[0],
  subscription: Effect.Success<typeof Subscription>,
  changeTier: ChangeTierVerb,
  chargeProration: ChargeProrationVerb,
  account: string,
  request: AddAddOnRequest,
) {
  const plan = planOf(catalog, request.planId);

  if (plan === null) return yield* new PlanNotInCatalog({ tier: request.planId });

  // An add-on is the only plan that stacks beside every group. The attach path
  // treats a plan that is not an add-on as a group move, so naming one here is
  // an operation mistake rather than a plan the catalog lacks (ADR 0039 §2).
  if (plan.addOn !== true) {
    return yield* new PlanOperationUnsupported({
      planId: request.planId,
      reason: "not_an_add_on",
    });
  }

  const state = yield* subscription.state(Subscription.ref(account));

  if (state._tag !== "Subscribed") return yield* new NotSubscribed({ account });

  const changed = yield* changeTier({
    tier: request.planId,
    dedupeKey: request.idempotencyKey,
    ...(request.grants === undefined ? {} : { grants: request.grants }),
  });

  // An add-on bought mid-period moves money like any other plan move. The
  // proration is the one `ChangeTier` computed from the standing; billing it
  // here keeps the add-on from being silently free for the first period.
  if ((changed.proration?.due ?? 0) > 0) yield* chargeProration();

  return { outcome: "added", planId: changed.tier } as const satisfies AddAddOnResult;
});

/**
 * Attach an add-on plan beside whatever the account already runs. It is a named
 * verb because the attach path's add-on branch is a branch: a caller that means
 * "add an add-on" says so, and a plan that is not one is refused rather than
 * quietly replacing a group's plan.
 *
 * ### Stacking an add-on
 * **Example:** Add the support plan beside the product plan
 * ```typescript
 * const addAddOn = yield* Paykit.AddAddOn(account);
 * yield* addAddOn({ planId: "support", idempotencyKey: "add-support" });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.AddAddOn
 */
export interface AddAddOn extends Binding.Service<
  AddAddOn,
  "Paykit.AddAddOn",
  (account: string) => Effect.Effect<AddAddOnVerb>
> {}

export const AddAddOn = Binding.Service<AddAddOn>("Paykit.AddAddOn");

/** The in-process layer, beside the `ChangeTier` it composes. */
export const AddAddOnInProcess = Layer.effect(
  AddAddOn,
  Effect.gen(function* () {
    const catalog = yield* CatalogService;
    const subscription = yield* Subscription;
    const bindChangeTier = yield* ChangeTier;
    const bindChargeProration = yield* ChargeProration;

    return Effect.fn("Paykit.AddAddOn")(function* (account) {
      const changeTier = yield* bindChangeTier(account);
      const chargeProration = yield* bindChargeProration(account);

      return Effect.fn("Paykit.AddAddOn.account")(function* (request) {
        return yield* addAddOnWith(
          catalog,
          subscription,
          changeTier,
          chargeProration,
          account,
          request,
        );
      });
    });
  }),
);
