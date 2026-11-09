import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Allowance } from "../Allowance.ts";
import { asSystem } from "../Auth/Actor.ts";
import { planOf, planTermsOf, type Catalog } from "../Catalog.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CatalogService } from "../CatalogService.ts";
import { AlreadyCanceled } from "../Subscription/AlreadyCanceled.rejection.ts";
import { DefaultPlanNotCancelable, PlanGroupEmpty } from "../Subscription/CancelGroup.command.ts";
import { ChangePlans, PlanMove } from "../Subscription/ChangePlans.command.ts";
import {
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
} from "../Subscription/ChangeTier.command.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotScheduled } from "../Subscription/NotScheduled.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { type PlanCancellationRequest } from "../Subscription/PlanCancellation.ts";
import { PlanGroupOccupied } from "../Subscription/PlanGroupOccupied.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { PlanPhaseAtSameInstant } from "../Subscription/PlanPhaseAtSameInstant.rejection.ts";
import { PlanPhaseNamesAddOn } from "../Subscription/PlanPhaseNamesAddOn.rejection.ts";
import { PlanPhaseNotFuture } from "../Subscription/PlanPhaseNotFuture.rejection.ts";
import { StandingEnded } from "../Subscription/StandingEnded.rejection.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import {
  currencyOf,
  isTerminalStatus,
  priceOf,
  scheduleOf,
  type SubscribedState,
} from "../Subscription/Subscription.state.ts";
import { withGrants } from "../TierCommand.ts";
import { PlanSchedule } from "./Attach.binding.ts";
import { defaultPlanFor } from "./Cancel.binding.ts";
import { PlanOperationUnsupported } from "./PlanOperationUnsupported.ts";

/** One plan in a multi-plan request. */
export const MultiPlanRequestPlan = Schema.Struct({
  /** The plan to buy or move to. */
  planId: Schema.String,
  /**
   * The plan items a custom plan is sold with, when they differ from the
   * catalog's defaults (ADR 0041).
   */
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  /**
   * When this move takes effect. An add-on and a new group move immediately; a
   * smaller plan in a filled group waits for the boundary by default.
   */
  planSchedule: Schema.optionalKey(PlanSchedule),
  /** The instant a scheduled move starts. Defaults to the period boundary. */
  at: Schema.optionalKey(Schema.DateTimeUtc),
});

export type MultiPlanRequestPlan = typeof MultiPlanRequestPlan.Type;

/** What `multiAttach` asks for: several plan moves under one retry key. */
export const MultiAttachRequest = Schema.Struct({
  plans: Schema.Array(MultiPlanRequestPlan),
  /** The retry key, which is also the command id of the one operation. */
  idempotencyKey: Schema.String,
});

export type MultiAttachRequest = typeof MultiAttachRequest.Type;

/** What `multiUpdate` asks for. It is the same transaction over the plan set. */
export const MultiUpdateRequest = Schema.Struct({
  plans: Schema.Array(MultiPlanRequestPlan),
  /** The groups to cancel at their boundary, in the same transaction. */
  cancels: Schema.optionalKey(Schema.Array(Schema.Struct({ group: Schema.String }))),
  /** The groups whose pending cancellation to clear, in the same transaction. */
  uncancels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The retry key, which is also the command id of the one operation. */
  idempotencyKey: Schema.String,
});

export type MultiUpdateRequest = typeof MultiUpdateRequest.Type;

/** What a multi-plan operation did. */
export interface MultiPlanResult {
  /**
   * `changed` when every move took effect now, `scheduled` when every one
   * waits, `mixed` when some did and some wait, `updated` when the operation
   * only changed a group's cancellation.
   */
  readonly outcome: "changed" | "scheduled" | "mixed" | "updated";
  /** Every plan the operation named, in request order. */
  readonly planIds: ReadonlyArray<string>;
  /** The plans that will land later, in start order. */
  readonly pendingPlanIds: ReadonlyArray<string>;
}

const amountOf = (price: { readonly amount: number } | undefined): number => price?.amount ?? 0;

const isActive = (state: SubscribedState): boolean =>
  state.status === "trialing" || state.status === "active" || state.status === "grace";

/**
 * Turn one request plan into the aggregate move it implies. The catalog terms
 * are the payload, exactly as `ChangeTier` and `ScheduleTierChange` join them;
 * the operation never trusts a caller to carry them.
 */
const moveOf = (
  catalog: Catalog,
  state: SubscribedState,
  request: MultiPlanRequestPlan,
): PlanMove | PlanNotInCatalog | CatalogMismatch => {
  const tier = planOf(catalog, request.planId);

  if (tier === null) return new PlanNotInCatalog({ tier: request.planId });
  const terms = planTermsOf(catalog, request.planId, currencyOf(state));

  if (terms === null || terms.kind === "one_off") {
    return new PlanNotInCatalog({ tier: request.planId });
  }

  const granted = withGrants(catalog, { tier: request.planId, ...terms }, request.grants);

  if (granted.mismatch !== null) return granted.mismatch;
  const input = granted.input;

  // A new group has nothing to replace, so its plan lands now; a smaller plan
  // in a group that already holds one waits for the boundary, the same rule a
  // single `attach` uses.
  const inGroup = Object.values(state.plans).some(
    (row) => !row.addOn && row.group === (tier.group ?? "default"),
  );

  const upgrade =
    tier.addOn === true || !inGroup || amountOf(terms.price) > amountOf(priceOf(state));

  const immediate = upgrade || request.planSchedule === "immediate";

  return {
    tier: request.planId,
    ...(terms.group === undefined ? {} : { group: terms.group }),
    ...(terms.addOn === true ? { addOn: true } : {}),
    allowances: input.allowances,
    ...(input.price === undefined ? {} : { price: input.price }),
    credits: input.credits,
    creditsExpire: input.creditsExpire,
    ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
    rates: input.rates,
    ...(immediate ? {} : { at: request.at ?? state.period.end }),
  };
};

const multiPlanOperation = Effect.fn("Paykit.MultiPlan.attach")(function* (
  catalog: Catalog,
  subscription: Effect.Success<typeof Subscription>,
  account: string,
  request: MultiAttachRequest | MultiUpdateRequest,
) {
  const state = yield* subscription.state(Subscription.ref(account));

  if (state._tag !== "Subscribed" || !isActive(state) || isTerminalStatus(state.status)) {
    return yield* new PlanOperationUnsupported({
      planId: request.plans[0]?.planId ?? "",
      reason: "multi_plan_on_inactive",
    });
  }

  const moves: Array<PlanMove> = [];

  for (const plan of request.plans) {
    const move = moveOf(catalog, state, plan);

    if (!Schema.is(PlanMove)(move)) return yield* move;

    moves.push(move);
  }

  const cancels: Array<PlanCancellationRequest> =
    "cancels" in request
      ? (request.cancels ?? []).map((cancellation) => {
          const fallback = defaultPlanFor(catalog, cancellation.group, currencyOf(state));

          return {
            group: cancellation.group,
            ...(fallback === undefined ? {} : { fallback }),
          };
        })
      : [];

  const uncancels = "uncancels" in request ? (request.uncancels ?? []) : [];

  // One command, one command id, one transaction: the aggregate validates the
  // whole list against the state before it records any event (ADR 0039 §8).
  yield* asSystem(
    subscription.send(
      Subscription.ref(account),
      new ChangePlans({
        moves,
        ...(cancels.length === 0 ? {} : { cancels }),
        ...(uncancels.length === 0 ? {} : { uncancels }),
      }),
      { commandId: request.idempotencyKey },
    ),
  );

  const after = yield* subscription.state(Subscription.ref(account));
  const pending = after._tag === "Subscribed" ? scheduleOf(after) : [];
  const changed = moves.filter((move) => move.at === undefined).length;

  const outcome =
    moves.length === 0
      ? "updated"
      : changed === 0
        ? "scheduled"
        : changed === moves.length
          ? "changed"
          : "mixed";

  return {
    outcome,
    planIds: moves.map((move) => move.tier),
    pendingPlanIds: pending.map((phase) => phase.planId),
  } as const satisfies MultiPlanResult;
});

/** Everything a multi-plan operation can fail with. */
export type MultiPlanError =
  | CatalogMismatch
  | PlanOperationUnsupported
  | PlanNotInCatalog
  | NotSubscribed
  | StandingEnded
  | CurrencyMismatch
  | PlanGroupOccupied
  | PlanPhaseNotFuture
  | PlanPhaseAtSameInstant
  | PlanPhaseNamesAddOn
  | DowngradeBelowUsage
  | DowngradeBelowSpend
  | DowngradeBelowCeiling
  | AlreadyCanceled
  | DefaultPlanNotCancelable
  | PlanGroupEmpty
  | NotScheduled;

// SAFETY: the generator yields exactly the refusals `ChangePlans` declares plus
// the catalog checks above; the cast names that union once for the two verbs
// that share the operation, so neither layer leaks an `unknown` error channel.
const multiPlanWith = multiPlanOperation as (
  catalog: Catalog,
  subscription: Effect.Success<typeof Subscription>,
  account: string,
  request: MultiAttachRequest | MultiUpdateRequest,
) => Effect.Effect<MultiPlanResult, MultiPlanError>;

/** The verb of a bound `MultiAttach`. */
export type MultiAttachVerb = (
  request: MultiAttachRequest,
) => Effect.Effect<MultiPlanResult, MultiPlanError>;

/**
 * Attach several plans in one transaction: a plan into a new group, an add-on
 * beside it, or a phase for a later boundary. The whole request is one command
 * with one retry key, so a retry replays the plan set or none of it.
 *
 * ### Attaching a second group and an add-on
 * **Example:** A support plan beside the product plan
 * ```typescript
 * const multi = yield* Paykit.MultiAttach(account);
 * yield* multi({
 *   plans: [{ planId: "support" }, { planId: "analytics", planSchedule: "end_of_cycle" }],
 *   idempotencyKey: "plan-set-1",
 * });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.MultiAttach
 */
export interface MultiAttach extends Binding.Service<
  MultiAttach,
  "Paykit.MultiAttach",
  (account: string) => Effect.Effect<MultiAttachVerb>
> {}

export const MultiAttach = Binding.Service<MultiAttach>("Paykit.MultiAttach");

/** The verb of a bound `MultiUpdate`. */
export type MultiUpdateVerb = (
  request: MultiUpdateRequest,
) => Effect.Effect<MultiPlanResult, MultiPlanError>;

/**
 * Change several plans in one transaction. It is `multiAttach` under the name
 * an update uses: a plan set move, a phase and (once the group commands land) a
 * cancellation, all under one command id.
 *
 * @binding
 * @product Plans
 * @provides Paykit.MultiUpdate
 */
export interface MultiUpdate extends Binding.Service<
  MultiUpdate,
  "Paykit.MultiUpdate",
  (account: string) => Effect.Effect<MultiUpdateVerb>
> {}

export const MultiUpdate = Binding.Service<MultiUpdate>("Paykit.MultiUpdate");

const makeDeps = Effect.gen(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;

  return { catalog, subscription };
});

/** The in-process `MultiAttach` layer. */
export const MultiAttachInProcess = Layer.effect(
  MultiAttach,
  Effect.gen(function* () {
    const deps = yield* makeDeps;

    return Effect.fn("Paykit.MultiAttach")(function* (account) {
      return Effect.fn("Paykit.MultiAttach.account")(function* (request) {
        return yield* multiPlanWith(deps.catalog, deps.subscription, account, request);
      });
    });
  }),
);

/** The in-process `MultiUpdate` layer. */
export const MultiUpdateInProcess = Layer.effect(
  MultiUpdate,
  Effect.gen(function* () {
    const deps = yield* makeDeps;

    return Effect.fn("Paykit.MultiUpdate")(function* (account) {
      return Effect.fn("Paykit.MultiUpdate.account")(function* (request) {
        return yield* multiPlanWith(deps.catalog, deps.subscription, account, request);
      });
    });
  }),
);
