import {
  type Feature,
  Paykit,
  type Plan,
  type PreviewCommand as PreviewCommandValue,
} from "@potion.run/paykit";
import type {
  CheckRequest,
  ChangeTierRequest,
  HoldRequest,
  SetQuantityRequest,
  SetUsageRequest,
  StartTrialRequest,
  SubscribeRequest,
  TrackUsageRequest,
} from "@potion.run/paykit/Billing";
import * as Effect from "effect/Effect";

/**
 * A feature a meter counts: `messages` and `ai` in this catalog, never `seats`
 * (set) or `sso` (granted). The narrowing is what turns "track a flag" and
 * "hold a seat" from the model's `FeatureNotMetered` refusal into a compile
 * error at the call site.
 */
export type MeteredFeature = Feature & { readonly kind: "metered" };

/** A feature that is set rather than spent: `seats`. */
export type QuantityFeature = Feature & { readonly kind: "non_consumable" };

/** `check` takes any declared feature: a flag answers whether it is on. */
type CheckUsage = Omit<CheckRequest, "featureId"> & { readonly feature: Feature };

/** `track` takes a metered feature, because only a meter has a count. */
type TrackUsage = Omit<TrackUsageRequest, "featureId"> & {
  readonly feature: MeteredFeature;
};

/** A hold reserves counted units, so the feature has to be metered. */
type HoldUsage = Omit<HoldRequest, "feature"> & { readonly feature: MeteredFeature };

/** A quantity is bought, not spent. */
type SetQuantity = Omit<SetQuantityRequest, "feature"> & {
  readonly feature: QuantityFeature;
};

/** Occupancy is the used part of a quantity, not a spend. */
type SetUsage = Omit<SetUsageRequest, "featureId"> & {
  readonly feature: QuantityFeature;
};

/** A purchase names a declared plan; the deployment joins its terms. */
type SubscribePlan = Omit<SubscribeRequest, "tier"> & { readonly plan: Plan };

/** A move names a declared plan; its proration is the move's own. */
type ChangePlan = Omit<ChangeTierRequest, "tier"> & { readonly plan: Plan };

/** A trial names a declared plan; the plan's price states the cadence. */
type StartTrialPlan = Omit<StartTrialRequest, "tier"> & { readonly plan: Plan };

/** A plan command with the declaration in place of the id it resolves to. */
type PreviewPlanOf<Kind extends "subscribe" | "changeTier" | "scheduleTierChange"> = Omit<
  Extract<PreviewCommandValue, { readonly kind: Kind }>,
  "kind" | "tier"
> & { readonly kind: Kind; readonly plan: Plan };

/** A preview of a plan command: the plan is the declaration, not its id. */
export type PreviewPlan =
  | PreviewPlanOf<"subscribe">
  | PreviewPlanOf<"changeTier">
  | PreviewPlanOf<"scheduleTierChange">;

/** Join the declaration back onto the command the preview decides. */
const previewCommandOf = (command: PreviewPlan): PreviewCommandValue => {
  switch (command.kind) {
    case "subscribe": {
      const { kind, plan, ...rest } = command;

      return { kind, tier: plan.id, ...rest };
    }

    case "changeTier": {
      const { kind, plan, ...rest } = command;

      return { kind, tier: plan.id, ...rest };
    }

    case "scheduleTierChange": {
      const { kind, plan, ...rest } = command;

      return { kind, tier: plan.id, ...rest };
    }
  }
};

/**
 * One account's end of the billing API, with the catalog in the types.
 *
 * A binding takes a plain `string` id because the same binding is a wire
 * contract, and over the wire a caller holds no declarations. An app does: it
 * imported `catalog.ts` to build the world. `Tenant(account)` closes that gap
 * once, at the edge, so every request downstream names what it acts on.
 *
 * - A verb accepts a declared `Feature` or `Plan`; an id nobody declared is not
 *   a value the example can produce.
 * - The feature's `kind` decides which verbs accept it: a flag cannot be
 *   tracked or held, and a seat is set rather than spent.
 * - Each verb is the library's own binding, so the refusals, the waits and the
 *   answers are the ones `Paykit.TrackUsage(account)` gives — this module adds
 *   types, not a second contract.
 *
 * The account is bound once, as the bindings bind it, so a caller cannot act
 * for one account and read another.
 *
 * ### A request's worth of usage
 * **Example:** Check, hold, then settle what ran
 * ```typescript
 * const tenant = yield* Tenant(account);
 *
 * const answer = yield* tenant.check({ feature: messages, requiredBalance: 1 });
 * const { holdId } = yield* tenant.hold({ feature: messages, amount: 30, dedupeKey: turnId });
 * const settled = yield* tenant.settleHold({ holdId, amount: 20, dedupeKey: `${turnId}:settle` });
 * // settled.billed === 20, settled.released === 10
 * ```
 *
 * @primitive
 */
export const Tenant = Effect.fn("Example.Tenant")(function* (account: string) {
  const checkOf = yield* Paykit.Check(account);
  const trackOf = yield* Paykit.TrackUsage(account);
  const holdOf = yield* Paykit.Hold(account);
  const settleHoldOf = yield* Paykit.SettleHold(account);
  const releaseHoldOf = yield* Paykit.ReleaseHold(account);
  const setQuantityOf = yield* Paykit.SetQuantity(account);
  const setUsageOf = yield* Paykit.SetUsage(account);
  const subscribeOf = yield* Paykit.Subscribe(account);
  const changePlanOf = yield* Paykit.ChangeTier(account);
  const startTrialOf = yield* Paykit.StartTrial(account);
  const previewOf = yield* Paykit.Preview(account);

  return {
    /**
     * Ask what the account may use now, without recording anything. A flag
     * answers `allowed` with no count (`remaining: null`); a metered feature
     * answers its balance.
     */
    check: (request: CheckUsage) => {
      const { feature, ...rest } = request;

      return checkOf({ featureId: feature.id, ...rest });
    },

    /**
     * Record usage in the transaction that judges the allowance. The binding
     * waits for the entitlement view, so the next `check` sees this fact.
     */
    track: (request: TrackUsage) => {
      const { feature, ...rest } = request;

      return trackOf({ featureId: feature.id, ...rest });
    },

    /**
     * Reserve units for work in flight. The hold is an entity with an id, so
     * `settleHold` bills exactly this one and `releaseHold` returns it.
     */
    hold: (request: HoldUsage) => {
      const { feature, ...rest } = request;

      return holdOf({ feature: feature.id, ...rest });
    },

    /** Bill what ran and return the rest, in the same command. */
    settleHold: settleHoldOf,

    /** Return a hold without billing any of it. */
    releaseHold: releaseHoldOf,

    /** Set the amount of a non-consumable feature the account holds. */
    setQuantity: (request: SetQuantity) => {
      const { feature, ...rest } = request;

      return setQuantityOf({ feature: feature.id, ...rest });
    },

    /** Set how much of a non-consumable feature is in use. */
    setUsage: (request: SetUsage) => {
      const { feature, ...rest } = request;

      return setUsageOf({ featureId: feature.id, ...rest });
    },

    /**
     * Buy a declared plan. A free plan activates and waits for the
     * entitlement; a priced one answers the provider's checkout or invoice.
     */
    subscribe: (request: SubscribePlan) => {
      const { plan, ...rest } = request;

      return subscribeOf({ tier: plan.id, ...rest });
    },

    /** Move the standing to another declared plan and answer the proration. */
    changePlan: (request: ChangePlan) => {
      const { plan, ...rest } = request;

      return changePlanOf({ tier: plan.id, ...rest });
    },

    /** Open a trial on a declared plan, until a deadline the caller states. */
    startTrial: (request: StartTrialPlan) => {
      const { plan, ...rest } = request;

      return startTrialOf({ tier: plan.id, ...rest });
    },

    /**
     * Decide a plan command without recording it. The answer is the same pure
     * `decide` the write runs, so the quote cannot disagree with the charge.
     */
    preview: (command: PreviewPlan) => previewOf({ command: previewCommandOf(command) }),
  };
});
