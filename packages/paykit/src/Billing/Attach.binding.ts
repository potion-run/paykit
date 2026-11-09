import * as Binding from "alchemy/Binding";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Allowance, type Allowances } from "../Allowance.ts";
import { asSystem } from "../Auth/Actor.ts";
import { planItemsOf, planOf, planTermsOf, type Catalog } from "../Catalog.ts";
import { sameAllowances } from "../CatalogGuard.ts";
import { CatalogService } from "../CatalogService.ts";
import { EntityId } from "../Customer.ts";
import { Payments, ProviderCapabilityMissing, type PaymentsService } from "../Payments.ts";
import { unusedFraction } from "../Proration.ts";
import type { Proration } from "../Proration.ts";
import { CancelImmediately } from "../Subscription/CancelImmediately.command.ts";
import { EntityArchived } from "../Subscription/EntityArchived.rejection.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import {
  entityOf,
  refundableOf,
  scopeStateOf,
  type SubscriptionState,
} from "../Subscription/Subscription.state.ts";
import { planIdOf, priceOf, currencyOf } from "../Subscription/Subscription.state.ts";
import type { CancelVerb, ResumeVerb } from "./Cancel.binding.ts";
import { Resume, ScheduleCancellation } from "./Cancel.binding.ts";
import type { ChangeTierVerb } from "./ChangeTier.binding.ts";
import { ChangeTier } from "./ChangeTier.binding.ts";
import type { ChargeQuantityProrationVerb } from "./ChargeQuantityProration.binding.ts";
import { ChargeQuantityProration } from "./ChargeQuantityProration.binding.ts";
import { PlanOperationUnsupported } from "./PlanOperationUnsupported.ts";
import type { ChargeProrationVerb } from "./Portal.binding.ts";
import { ChargeProration } from "./Portal.binding.ts";
import type { PreviewVerb } from "./Preview.binding.ts";
import { Preview } from "./Preview.binding.ts";
import type { PreviewResult } from "./Preview.operation.ts";
import type {
  ScheduleTierChangeVerb,
  WithdrawTierChangeVerb,
} from "./ScheduleTierChange.binding.ts";
import { ScheduleTierChange, WithdrawTierChange } from "./ScheduleTierChange.binding.ts";
import type { SetQuantityVerb } from "./SetQuantity.binding.ts";
import { SetQuantity } from "./SetQuantity.binding.ts";
import type { SubscribeVerb } from "./Subscribe.binding.ts";
import { Subscribe } from "./Subscribe.binding.ts";

/** One quantity to set on a plan operation. */
export const FeatureQuantity = Schema.Struct({
  featureId: Schema.String,
  quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type FeatureQuantity = typeof FeatureQuantity.Type;

/** When a plan move takes effect. */
export const PlanSchedule = Schema.Literals(["immediate", "end_of_cycle"]);

export type PlanSchedule = typeof PlanSchedule.Type;

/** How the money a plan move produces is collected. */
export const ProrationBehavior = Schema.Literals(["prorate_immediately", "none"]);

export type ProrationBehavior = typeof ProrationBehavior.Type;

/** What a caller asks `attach` to do. */
export const AttachRequest = Schema.Struct({
  /** The plan to buy or move to. */
  planId: Schema.String,
  /** The entity scope to attach it to; absent means the customer's own scope. */
  entityId: Schema.optionalKey(EntityId),
  /**
   * The plan items a custom plan is sold with, when they differ from the
   * catalog's defaults. Omitted means the plan's `grants` (ADR 0041 §6).
   */
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  /** Quantities to set on a non-consumable feature, after the plan move. */
  featureQuantities: Schema.optionalKey(Schema.Array(FeatureQuantity)),
  /**
   * When the move takes effect. A downgrade defaults to `end_of_cycle`; an
   * upgrade is immediate.
   */
  planSchedule: Schema.optionalKey(PlanSchedule),
  /** Whether a positive proration is collected in this operation. */
  prorationBehavior: Schema.optionalKey(ProrationBehavior),
  /** The retry key, which is also the command id of every command this makes. */
  idempotencyKey: Schema.String,
});

export type AttachRequest = typeof AttachRequest.Type;

/** What a plan operation did. */
export interface AttachResult {
  readonly outcome: "activated" | "checkout" | "invoiced" | "changed" | "scheduled" | "updated";
  readonly planId: string;
  /** The plan that will land at the boundary, when one was scheduled. */
  readonly pendingPlanId?: string;
  /** The money this operation moved, when it moved any. */
  readonly proration?: Proration;
  /** The provider's checkout URL, when the plan went through a hosted purchase. */
  readonly paymentUrl?: string;
  /** The provider's invoice id, when the plan was invoiced. */
  readonly invoiceId?: string;
}

/** What an update asks to do about the plan's future. */
export const CancelAction = Schema.Literals([
  "cancel_end_of_cycle",
  "cancel_immediately",
  "uncancel",
]);

export type CancelAction = typeof CancelAction.Type;

/** What a caller asks `update` to do. */
export const UpdateRequest = Schema.Struct({
  /** The plan to update; omitted means the only active plan. */
  planId: Schema.optionalKey(Schema.String),
  /** The entity scope to update; absent means the customer's own scope. */
  entityId: Schema.optionalKey(EntityId),
  /** Quantities to set on a non-consumable feature. */
  featureQuantities: Schema.optionalKey(Schema.Array(FeatureQuantity)),
  /** A cancellation, an uncancel, or neither. */
  cancelAction: Schema.optionalKey(CancelAction),
  /**
   * The group the cancellation or uncancel names. Absent means the whole
   * standing, which is the account-wide cancellation a single-group deployment
   * uses (ADR 0039 §5).
   */
  cancelGroup: Schema.optionalKey(Schema.String),
  /** The retry key, which is also the command id of every command this makes. */
  idempotencyKey: Schema.String,
  /** A charge id for an immediate cancellation; omitted means the latest plan charge. */
  chargeId: Schema.optionalKey(Schema.String),
});

export type UpdateRequest = typeof UpdateRequest.Type;

/** What an update did. */
export interface UpdateResult {
  readonly outcome: "updated" | "canceled" | "uncanceled";
  readonly planId: string;
  /** The plan that will land at the boundary, when one is still scheduled. */
  readonly pendingPlanId?: string;
  /** The money a quantity change moved. */
  readonly proration?: Proration;
  /** The provider invoice for a quantity change, when one was opened. */
  readonly invoiceId?: string;
  /** The provider refund an immediate cancellation took. */
  readonly refundId?: string;
  /** Minor units returned by an immediate cancellation. */
  readonly refunded?: number;
}

/** What a caller asks `previewAttach` to show. */
export const PreviewAttachRequest = Schema.Struct({
  planId: Schema.String,
  /** The entity scope the move would write; absent means the customer. */
  entityId: Schema.optionalKey(EntityId),
  /** The bespoke items a custom plan is quoted at, when any. */
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  featureQuantities: Schema.optionalKey(Schema.Array(FeatureQuantity)),
  planSchedule: Schema.optionalKey(PlanSchedule),
  prorationBehavior: Schema.optionalKey(ProrationBehavior),
});

export type PreviewAttachRequest = typeof PreviewAttachRequest.Type;

/** The plan move a preview would make, and the preview itself. */
export interface PreviewAttachResult {
  readonly outcome: AttachResult["outcome"];
  readonly planId: string;
  readonly pendingPlanId?: string;
  readonly preview?: PreviewResult;
}

/** What a caller asks `previewUpdate` to show. */
export const PreviewUpdateRequest = Schema.Struct({
  planId: Schema.optionalKey(Schema.String),
  /** The entity scope the update would write; absent means the customer. */
  entityId: Schema.optionalKey(EntityId),
  featureQuantities: Schema.optionalKey(Schema.Array(FeatureQuantity)),
  cancelAction: Schema.optionalKey(CancelAction),
  /** The group the cancellation or uncancel names; absent means the standing. */
  cancelGroup: Schema.optionalKey(Schema.String),
});

export type PreviewUpdateRequest = typeof PreviewUpdateRequest.Type;

/** One preview per command the update would send. */
export interface PreviewUpdateResult {
  readonly previews: ReadonlyArray<PreviewResult>;
}

/** A plan operation that needs a capability the current slice does not have. */
export { PlanOperationUnsupported } from "./PlanOperationUnsupported.ts";

type SubscriptionService = Effect.Success<typeof Subscription>;

interface QuantityRequest {
  readonly featureQuantities?: ReadonlyArray<FeatureQuantity>;
  readonly idempotencyKey: string;
  readonly prorationBehavior?: ProrationBehavior;
  readonly entityId?: EntityId;
}

interface AttachDeps {
  readonly catalog: Catalog;
  readonly subscription: SubscriptionService;
  readonly subscribe: (account: string) => Effect.Effect<SubscribeVerb>;
  readonly changeTier: (account: string) => Effect.Effect<ChangeTierVerb>;
  readonly scheduleTierChange: (account: string) => Effect.Effect<ScheduleTierChangeVerb>;
  readonly setQuantity: (account: string) => Effect.Effect<SetQuantityVerb>;
  readonly chargeProration: (account: string) => Effect.Effect<ChargeProrationVerb>;
  readonly chargeQuantityProration: (account: string) => Effect.Effect<ChargeQuantityProrationVerb>;
  readonly scheduleCancellation: (account: string) => Effect.Effect<CancelVerb>;
  readonly resume: (account: string) => Effect.Effect<ResumeVerb>;
  readonly withdrawTierChange: (account: string) => Effect.Effect<WithdrawTierChangeVerb>;
  readonly preview: (account: string) => Effect.Effect<PreviewVerb>;
}

const isActive = (
  state: SubscriptionState,
): state is Extract<SubscriptionState, { _tag: "Subscribed" }> =>
  state._tag === "Subscribed" &&
  (state.status === "trialing" || state.status === "active" || state.status === "grace");

const amountOf = (price: { readonly amount: number } | undefined): number => price?.amount ?? 0;

/** A bespoke item list folded to the record a command and a plan row carry. */
const allowancesOfGrants = (grants: ReadonlyArray<Allowance>): Allowances => {
  const allowances: Record<string, Allowance> = {};

  for (const grant of grants) allowances[grant.feature] = grant;

  return allowances;
};

/**
 * Whether a request states items the catalog does not: the one case a hosted
 * checkout cannot carry, because the activation is rebuilt from the catalog
 * when the provider's webhook lands (ADR 0041 §7).
 */
const isBespoke = (
  catalog: Catalog,
  planId: string,
  grants: ReadonlyArray<Allowance> | undefined,
): boolean => {
  if (grants === undefined) return false;
  const stated = planItemsOf(catalog, planId);

  if (stated === null) return false;

  return !sameAllowances(stated, allowancesOfGrants(grants));
};

/** The `grants` a verb takes, spread only when the request states any. */
const grantsOf = (request: {
  readonly grants?: ReadonlyArray<Allowance>;
}): { readonly grants?: ReadonlyArray<Allowance> } =>
  request.grants === undefined ? {} : { grants: request.grants };

/**
 * The refusal a named scope earns before a plan operation reads or writes it.
 * An entity is created first; a write never invents a detached scope.
 */
const entityRefusalOf = (
  state: SubscriptionState,
  entityId: EntityId | undefined,
  account: string,
): EntityUnknown | EntityArchived | null => {
  if (entityId === undefined) return null;
  const record = entityOf(state, entityId);

  if (record === undefined) return new EntityUnknown({ account, entityId });

  return record.status === "archived"
    ? new EntityArchived({
        entityId,
        archivedAt: record.archivedAt ?? record.createdAt,
      })
    : null;
};

const attachWith = Effect.fn("Paykit.Attach.attach")(function* (
  deps: AttachDeps,
  account: string,
  request: AttachRequest,
) {
  const subscribe = yield* deps.subscribe(account);
  const changeTier = yield* deps.changeTier(account);
  const scheduleTierChange = yield* deps.scheduleTierChange(account);
  const chargeProration = yield* deps.chargeProration(account);
  const tier = planOf(deps.catalog, request.planId);

  if (tier === null) return yield* new PlanNotInCatalog({ tier: request.planId });

  const state = yield* deps.subscription.state(Subscription.ref(account));
  const refusal = entityRefusalOf(state, request.entityId, account);

  if (refusal !== null) return yield* refusal;

  const scoped = scopeStateOf(state, request.entityId);

  const terms = planTermsOf(
    deps.catalog,
    request.planId,
    state._tag === "Subscribed" ? currencyOf(scoped) : undefined,
  );

  if (terms === null) return yield* new PlanNotInCatalog({ tier: request.planId });

  const kind = tier.kind ?? "subscription";
  const grants = grantsOf(request);

  // A child scope holds a plan beside the customer's standing. It cannot open
  // the customer's standing and it is not a checkout: the customer attaches
  // first, then the entity.
  if (request.entityId !== undefined && (!isActive(state) || kind === "one_off")) {
    return yield* new PlanOperationUnsupported({
      planId: request.planId,
      reason: "entity_on_unsubscribed_customer",
    });
  }

  // A one-off plan is a purchase, not a standing change.
  if (kind === "one_off") {
    const result = yield* subscribe({ tier: request.planId, ...grants });

    return "url" in result
      ? ({ outcome: "checkout", planId: request.planId, paymentUrl: result.url } as const)
      : "invoiceId" in result
        ? ({ outcome: "invoiced", planId: request.planId, invoiceId: result.invoiceId } as const)
        : ({ outcome: "activated", planId: request.planId } as const);
  }

  // A new or terminal standing is an activation.
  if (!isActive(state)) {
    if (request.featureQuantities !== undefined && request.featureQuantities.length > 0) {
      const result = yield* subscribe({ tier: request.planId, ...grants });

      if ("url" in result || "invoiceId" in result) {
        return yield* new PlanOperationUnsupported({
          planId: request.planId,
          reason: "quantities_on_checkout",
        });
      }

      return yield* applyQuantities(deps, account, request, {
        outcome: "activated",
        planId: request.planId,
      });
    }

    const result = yield* subscribe({ tier: request.planId, ...grants });

    return "url" in result
      ? ({ outcome: "checkout", planId: request.planId, paymentUrl: result.url } as const)
      : "invoiceId" in result
        ? ({ outcome: "invoiced", planId: request.planId, invoiceId: result.invoiceId } as const)
        : ({ outcome: "activated", planId: request.planId } as const);
  }

  // The same plan is a replay, not a second activation; quantities can still
  // change. An add-on is kept by id, because `planIdOf` answers the group's
  // base plan. A bespoke set that differs from the one in force is not a
  // replay, though: it is a new deal on the same plan, so it takes the ordinary
  // move path and its timing (the boundary unless the caller asks for it now),
  // and the phase it writes carries the terms (ADR 0041 §6).
  if (planIdOf(state) === request.planId || state.plans[request.planId] !== undefined) {
    const inForce = state.plans[request.planId]?.allowances;

    const redeal =
      request.grants !== undefined &&
      inForce !== undefined &&
      !sameAllowances(inForce, allowancesOfGrants(request.grants));

    if (!redeal) {
      return yield* applyQuantities(deps, account, request, {
        outcome: "updated",
        planId: request.planId,
      });
    }
  }

  // An add-on stacks beside every group instead of replacing one, so it is
  // immediate by construction: there is no group slot to schedule a move into.
  const addOn = tier.addOn === true;
  const upgrade = addOn || amountOf(terms.price) > amountOf(priceOf(state));
  const immediate = upgrade || request.planSchedule === "immediate";

  if (!immediate) {
    if (request.entityId !== undefined) {
      return yield* new PlanOperationUnsupported({
        planId: request.planId,
        reason: "entity_on_scheduled_change",
      });
    }

    if (request.featureQuantities !== undefined && request.featureQuantities.length > 0) {
      return yield* new PlanOperationUnsupported({
        planId: request.planId,
        reason: "quantities_on_scheduled_change",
      });
    }

    const scheduled = yield* scheduleTierChange({
      tier: request.planId,
      dedupeKey: request.idempotencyKey,
      ...grants,
    });

    return {
      outcome: "scheduled",
      planId: planIdOf(state),
      pendingPlanId: scheduled.pendingTier ?? request.planId,
    } as const;
  }

  const changed = yield* changeTier({
    tier: request.planId,
    dedupeKey: request.idempotencyKey,
    ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
    ...grants,
  });

  const charged =
    request.prorationBehavior !== "none" && (changed.proration?.due ?? 0) > 0
      ? yield* chargeProration()
      : null;

  const withQuantities = yield* applyQuantities(deps, account, request, {
    outcome: "changed",
    planId: request.planId,
    ...(changed.proration === null ? {} : { proration: changed.proration }),
    ...(charged?.invoiceId === undefined ? {} : { invoiceId: charged.invoiceId }),
  });

  return withQuantities;
});

const applyQuantities = Effect.fn("Paykit.Attach.quantities")(function* (
  deps: AttachDeps,
  account: string,
  request: QuantityRequest,
  result: AttachResult,
) {
  if (request.featureQuantities === undefined) return result;
  const setQuantity = yield* deps.setQuantity(account);
  const chargeQuantityProration = yield* deps.chargeQuantityProration(account);

  for (const quantity of request.featureQuantities) {
    const key = `${request.idempotencyKey}:${quantity.featureId}`;

    const changed = yield* setQuantity({
      feature: quantity.featureId,
      quantity: quantity.quantity,
      ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
      dedupeKey: key,
    });

    if ((changed.proration?.due ?? 0) > 0 && request.prorationBehavior !== "none") {
      yield* chargeQuantityProration({ prorationId: key });
    }
  }

  return result;
});

const updateWith = Effect.fn("Paykit.Update.update")(function* (
  deps: AttachDeps,
  payments: PaymentsService | null,
  account: string,
  request: UpdateRequest,
) {
  const state = yield* deps.subscription.state(Subscription.ref(account));

  if (state._tag !== "Subscribed") return yield* new NotSubscribed({ account });

  const refusal = entityRefusalOf(state, request.entityId, account);

  if (refusal !== null) return yield* refusal;

  const scoped = scopeStateOf(state, request.entityId);
  const planId = request.planId ?? planIdOf(scoped);

  if (request.planId !== undefined && request.planId !== planIdOf(scoped)) {
    return yield* new PlanOperationUnsupported({ planId: request.planId, reason: "no_change" });
  }

  let outcome: UpdateResult["outcome"] = "updated";

  if (request.cancelAction === "cancel_immediately") {
    const at = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);

    const price = priceOf(state);

    const unused =
      price === undefined ? 0 : Math.round(price.amount * unusedFraction(state.period, at));

    const amount = price === undefined ? 0 : Math.min(unused, refundableOf(state, price.currency));

    let refund: { chargeId: string; refundId: string; amount: number; currency: string } | null =
      null;

    if (amount > 0) {
      const chargeId = request.chargeId ?? state.lastChargeId;

      if (chargeId === undefined) {
        return yield* new PlanOperationUnsupported({ planId, reason: "refund_charge_unknown" });
      }

      if (payments === null) {
        return yield* new ProviderCapabilityMissing({ provider: "none", op: "refund" });
      }

      const taken = yield* payments.refund({
        chargeId,
        amount,
        commandId: `${request.idempotencyKey}:refund`,
      });

      refund = {
        chargeId,
        refundId: taken.refundId,
        amount,
        currency: price!.currency,
      };
    }

    yield* asSystem(
      deps.subscription.send(
        Subscription.ref(account),
        new CancelImmediately(refund === null ? {} : { refund }),
        { commandId: request.idempotencyKey },
      ),
    );

    return {
      outcome: "canceled",
      planId,
      ...(refund === null ? {} : { refundId: refund.refundId, refunded: refund.amount }),
    } as const satisfies UpdateResult;
  }

  if (request.cancelAction === "cancel_end_of_cycle") {
    const cancel = yield* deps.scheduleCancellation(account);

    yield* cancel({
      dedupeKey: `${request.idempotencyKey}:cancel`,
      ...(request.cancelGroup === undefined ? {} : { group: request.cancelGroup }),
    });

    // A group cancellation drops that group's phases in the same command, so
    // only the whole-account path has a phase to withdraw. A cancellation wins
    // the boundary, so a pending plan change is withdrawn.
    if (request.cancelGroup === undefined && state.schedule.length > 0) {
      const withdraw = yield* deps.withdrawTierChange(account);

      yield* withdraw({ dedupeKey: `${request.idempotencyKey}:withdraw` }).pipe(
        Effect.catchTag("NoTierChangeScheduled", () => Effect.void),
      );
    }

    outcome = "canceled";
  }

  if (request.cancelAction === "uncancel") {
    let found = false;

    if (request.cancelGroup === undefined && state.schedule.length > 0) {
      const withdraw = yield* deps.withdrawTierChange(account);

      yield* withdraw({ dedupeKey: `${request.idempotencyKey}:withdraw` }).pipe(
        Effect.catchTag("NoTierChangeScheduled", () => Effect.void),
      );
      found = true;
    }

    if (request.cancelGroup !== undefined) {
      const resume = yield* deps.resume(account);

      yield* resume({
        dedupeKey: `${request.idempotencyKey}:resume`,
        group: request.cancelGroup,
      });
      found = true;
    } else if (state.cancelAtPeriodEnd) {
      const resume = yield* deps.resume(account);

      yield* resume({ dedupeKey: `${request.idempotencyKey}:resume` });
      found = true;
    }

    if (!found) {
      return yield* new PlanOperationUnsupported({ planId, reason: "nothing_to_uncancel" });
    }

    outcome = "uncanceled";
  }

  yield* applyQuantities(deps, account, request, { outcome: "updated", planId });

  return { outcome, planId } as const satisfies UpdateResult;
});

const previewAttachWith = Effect.fn("Paykit.PreviewAttach.preview")(function* (
  deps: AttachDeps,
  account: string,
  request: PreviewAttachRequest,
) {
  const tier = planOf(deps.catalog, request.planId);

  if (tier === null) return yield* new PlanNotInCatalog({ tier: request.planId });

  const state = yield* deps.subscription.state(Subscription.ref(account));
  const refusal = entityRefusalOf(state, request.entityId, account);

  if (refusal !== null) return yield* refusal;

  const scoped = scopeStateOf(state, request.entityId);
  const preview = yield* deps.preview(account);
  const kind = tier.kind ?? "subscription";
  const grants = grantsOf(request);

  // A bespoke set cannot cross a hosted checkout: the activation is rebuilt
  // from the catalog when the provider's webhook lands (ADR 0041 §7). The
  // apply path refuses the same combination in `Subscribe`, so the preview must
  // not promise a deal the write would decline.
  const needsCheckout = tier.price !== undefined || kind === "one_off";

  if (needsCheckout && isBespoke(deps.catalog, request.planId, request.grants)) {
    return yield* new PlanOperationUnsupported({
      planId: request.planId,
      reason: "custom_plan_checkout",
    });
  }

  if (request.entityId !== undefined && (!isActive(state) || kind === "one_off")) {
    return yield* new PlanOperationUnsupported({
      planId: request.planId,
      reason: "entity_on_unsubscribed_customer",
    });
  }

  if (kind === "one_off" || !isActive(state)) {
    return {
      // A command preview cannot know whether the provider will open a
      // checkout, but a priced plan is a purchase until it is paid.
      outcome: needsCheckout ? "checkout" : "activated",
      planId: request.planId,
      preview: yield* preview({ command: { kind: "subscribe", tier: request.planId, ...grants } }),
    } as const satisfies PreviewAttachResult;
  }

  if (planIdOf(state) === request.planId) {
    const inForce = state.plans[request.planId]?.allowances;

    const redeal =
      request.grants !== undefined &&
      inForce !== undefined &&
      !sameAllowances(inForce, allowancesOfGrants(request.grants));

    if (!redeal) {
      return { outcome: "updated", planId: request.planId } as const satisfies PreviewAttachResult;
    }
  }

  const terms = planTermsOf(
    deps.catalog,
    request.planId,
    state._tag === "Subscribed" ? currencyOf(scoped) : undefined,
  );

  if (terms === null) return yield* new PlanNotInCatalog({ tier: request.planId });

  const upgrade = amountOf(terms.price) > amountOf(priceOf(scoped));
  const immediate = upgrade || request.planSchedule === "immediate";

  if (!immediate) {
    if (request.entityId !== undefined) {
      return yield* new PlanOperationUnsupported({
        planId: request.planId,
        reason: "entity_on_scheduled_change",
      });
    }

    if (request.featureQuantities !== undefined && request.featureQuantities.length > 0) {
      return yield* new PlanOperationUnsupported({
        planId: request.planId,
        reason: "quantities_on_scheduled_change",
      });
    }

    return {
      outcome: "scheduled",
      planId: planIdOf(state),
      pendingPlanId: request.planId,
      preview: yield* preview({
        command: { kind: "scheduleTierChange", tier: request.planId, ...grants },
      }),
    } as const satisfies PreviewAttachResult;
  }

  return {
    outcome: "changed",
    planId: request.planId,
    preview: yield* preview({
      command: {
        kind: "changeTier",
        tier: request.planId,
        ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
        ...grants,
      },
    }),
  } as const satisfies PreviewAttachResult;
});

const previewUpdateWith = Effect.fn("Paykit.PreviewUpdate.preview")(function* (
  deps: AttachDeps,
  account: string,
  request: PreviewUpdateRequest,
) {
  const state = yield* deps.subscription.state(Subscription.ref(account));

  if (state._tag !== "Subscribed") return yield* new NotSubscribed({ account });

  const refusal = entityRefusalOf(state, request.entityId, account);

  if (refusal !== null) return yield* refusal;

  const scoped = scopeStateOf(state, request.entityId);
  const planId = request.planId ?? planIdOf(scoped);

  if (request.planId !== undefined && request.planId !== planIdOf(scoped)) {
    return yield* new PlanOperationUnsupported({ planId: request.planId, reason: "no_change" });
  }

  const preview = yield* deps.preview(account);
  const previews: Array<PreviewResult> = [];

  if (request.cancelAction === "cancel_immediately") {
    return yield* new PlanOperationUnsupported({ planId, reason: "cancel_immediately" });
  }

  if (request.cancelAction === "cancel_end_of_cycle") {
    previews.push(
      yield* preview({
        command:
          request.cancelGroup === undefined
            ? { kind: "cancel" }
            : { kind: "cancelGroup", group: request.cancelGroup },
      }),
    );

    if (request.cancelGroup === undefined && state.schedule.length > 0) {
      previews.push(yield* preview({ command: { kind: "withdrawTierChange" } }));
    }
  }

  if (request.cancelAction === "uncancel") {
    let found = false;

    if (request.cancelGroup === undefined && state.schedule.length > 0) {
      previews.push(yield* preview({ command: { kind: "withdrawTierChange" } }));
      found = true;
    }

    if (state.cancelAtPeriodEnd) {
      previews.push(yield* preview({ command: { kind: "resume" } }));
      found = true;
    }

    if (!found) {
      return yield* new PlanOperationUnsupported({ planId, reason: "nothing_to_uncancel" });
    }
  }

  for (const quantity of request.featureQuantities ?? []) {
    previews.push(
      yield* preview({
        command: {
          kind: "setQuantity",
          feature: quantity.featureId,
          quantity: quantity.quantity,
          ...(request.entityId === undefined ? {} : { entityId: request.entityId }),
        },
      }),
    );
  }

  return { previews } as const satisfies PreviewUpdateResult;
});

/** The verb of a bound `Attach`. */
export type AttachVerb = (request: AttachRequest) => Effect.Effect<AttachResult, AttachError>;

/** Everything an `attach` can fail with, inferred from the operations it composes. */
export type AttachError = Effect.Error<ReturnType<typeof attachWith>>;

/**
 * Buy a plan, move to a bigger one now, or schedule a smaller one for the
 * boundary. This is the operation a caller should use instead of choosing
 * between `Subscribe`, `ChangeTier` and `ScheduleTierChange`.
 *
 * An upgrade is immediate; a downgrade waits for the boundary by default. A
 * positive proration is collected in the same operation unless the caller asks
 * for no proration. Quantities for a scheduled change or a checkout are refused
 * for now, because the current commands cannot carry them.
 *
 * ### Buying or moving a plan
 * **Example:** A free plan, then an upgrade
 * ```typescript
 * const attach = yield* Paykit.Attach(account);
 * yield* attach({ planId: "free", idempotencyKey: "attach-1" });
 * yield* attach({ planId: "pro", idempotencyKey: "attach-2" });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.Attach
 */
export interface Attach extends Binding.Service<
  Attach,
  "Paykit.Attach",
  (account: string) => Effect.Effect<AttachVerb>
> {}

export const Attach = Binding.Service<Attach>("Paykit.Attach");

/** The verb of a bound `Update`. */
export type UpdateVerb = (request: UpdateRequest) => Effect.Effect<UpdateResult, UpdateError>;

/** Everything an `update` can fail with, inferred from the operations it composes. */
export type UpdateError = Effect.Error<ReturnType<typeof updateWith>>;

/**
 * Change quantities, cancel at the boundary, or take a future intent back. A
 * cancellation drops a pending plan change; an uncancel clears whichever intent
 * is pending. An immediate cancellation is refused until its command lands.
 *
 * ### Updating a running plan
 * **Example:** Change seats, then cancel
 * ```typescript
 * const update = yield* Paykit.Update(account);
 * yield* update({ idempotencyKey: "seats-1",
 *                 featureQuantities: [{ featureId: "seats", quantity: 8 }] });
 * yield* update({ idempotencyKey: "cancel-1", cancelAction: "cancel_end_of_cycle" });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.Update
 */
export interface Update extends Binding.Service<
  Update,
  "Paykit.Update",
  (account: string) => Effect.Effect<UpdateVerb>
> {}

export const Update = Binding.Service<Update>("Paykit.Update");

/** The in-process layer, provided beside the command bindings it composes. */
export const AttachInProcess = Layer.effect(
  Attach,
  Effect.gen(function* () {
    const catalog = yield* CatalogService;
    const subscription = yield* Subscription;
    const subscribe = yield* Subscribe;
    const changeTier = yield* ChangeTier;
    const scheduleTierChange = yield* ScheduleTierChange;
    const setQuantity = yield* SetQuantity;
    const chargeProration = yield* ChargeProration;
    const chargeQuantityProration = yield* ChargeQuantityProration;
    const scheduleCancellation = yield* ScheduleCancellation;
    const resume = yield* Resume;
    const withdrawTierChange = yield* WithdrawTierChange;
    const preview = yield* Preview;

    const deps: AttachDeps = {
      catalog,
      subscription,
      subscribe,
      changeTier,
      scheduleTierChange,
      setQuantity,
      chargeProration,
      chargeQuantityProration,
      scheduleCancellation,
      resume,
      withdrawTierChange,
      preview,
    };

    return Effect.fn("Paykit.Attach")(function* (account) {
      return Effect.fn("Paykit.Attach.account")(function* (request) {
        return yield* attachWith(deps, account, request);
      });
    });
  }),
);

/** The in-process `Update` layer, beside `AttachInProcess`. */
export const UpdateInProcess = Layer.effect(
  Update,
  Effect.gen(function* () {
    const catalog = yield* CatalogService;
    const subscription = yield* Subscription;
    const subscribe = yield* Subscribe;
    const changeTier = yield* ChangeTier;
    const scheduleTierChange = yield* ScheduleTierChange;
    const setQuantity = yield* SetQuantity;
    const chargeProration = yield* ChargeProration;
    const chargeQuantityProration = yield* ChargeQuantityProration;
    const scheduleCancellation = yield* ScheduleCancellation;
    const resume = yield* Resume;
    const withdrawTierChange = yield* WithdrawTierChange;
    const preview = yield* Preview;

    const deps: AttachDeps = {
      catalog,
      subscription,
      subscribe,
      changeTier,
      scheduleTierChange,
      setQuantity,
      chargeProration,
      chargeQuantityProration,
      scheduleCancellation,
      resume,
      withdrawTierChange,
      preview,
    };

    return Effect.fn("Paykit.Update")(function* (account) {
      return Effect.fn("Paykit.Update.account")(function* (request) {
        const payments = Option.getOrNull(yield* Effect.serviceOption(Payments));

        return yield* updateWith(deps, payments, account, request);
      });
    });
  }),
);

/** The verb of a bound `PreviewAttach`. */
export type PreviewAttachVerb = (
  request: PreviewAttachRequest,
) => Effect.Effect<PreviewAttachResult, PreviewAttachError>;

/** Everything a preview-attach can fail with, inferred from the preview it composes. */
export type PreviewAttachError = Effect.Error<ReturnType<typeof previewAttachWith>>;

/**
 * The plan move `attach` would make, decided without recording anything.
 *
 * ### Showing a plan change first
 * **Example:** Preview an upgrade
 * ```typescript
 * const preview = yield* Paykit.PreviewAttach(account);
 * const answer = yield* preview({ planId: "pro" });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.PreviewAttach
 */
export interface PreviewAttach extends Binding.Service<
  PreviewAttach,
  "Paykit.PreviewAttach",
  (account: string) => Effect.Effect<PreviewAttachVerb>
> {}

export const PreviewAttach = Binding.Service<PreviewAttach>("Paykit.PreviewAttach");

/** The verb of a bound `PreviewUpdate`. */
export type PreviewUpdateVerb = (
  request: PreviewUpdateRequest,
) => Effect.Effect<PreviewUpdateResult, PreviewUpdateError>;

/** Everything a preview-update can fail with, inferred from the previews it composes. */
export type PreviewUpdateError = Effect.Error<ReturnType<typeof previewUpdateWith>>;

/**
 * The commands `update` would send, decided without recording anything.
 *
 * ### Showing a cancellation first
 * **Example:** Preview a boundary cancellation
 * ```typescript
 * const preview = yield* Paykit.PreviewUpdate(account);
 * yield* preview({ cancelAction: "cancel_end_of_cycle" });
 * ```
 *
 * @binding
 * @product Plans
 * @provides Paykit.PreviewUpdate
 */
export interface PreviewUpdate extends Binding.Service<
  PreviewUpdate,
  "Paykit.PreviewUpdate",
  (account: string) => Effect.Effect<PreviewUpdateVerb>
> {}

export const PreviewUpdate = Binding.Service<PreviewUpdate>("Paykit.PreviewUpdate");

const makeDeps = Effect.gen(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const subscribe = yield* Subscribe;
  const changeTier = yield* ChangeTier;
  const scheduleTierChange = yield* ScheduleTierChange;
  const setQuantity = yield* SetQuantity;
  const chargeProration = yield* ChargeProration;
  const chargeQuantityProration = yield* ChargeQuantityProration;
  const scheduleCancellation = yield* ScheduleCancellation;
  const resume = yield* Resume;
  const withdrawTierChange = yield* WithdrawTierChange;
  const preview = yield* Preview;

  return {
    catalog,
    subscription,
    subscribe,
    changeTier,
    scheduleTierChange,
    setQuantity,
    chargeProration,
    chargeQuantityProration,
    scheduleCancellation,
    resume,
    withdrawTierChange,
    preview,
  } satisfies AttachDeps;
});

/** The in-process `PreviewAttach` layer. */
export const PreviewAttachInProcess = Layer.effect(
  PreviewAttach,
  Effect.gen(function* () {
    const deps = yield* makeDeps;

    return Effect.fn("Paykit.PreviewAttach")(function* (account) {
      return Effect.fn("Paykit.PreviewAttach.account")(function* (request) {
        return yield* previewAttachWith(deps, account, request);
      });
    });
  }),
);

/** The in-process `PreviewUpdate` layer. */
export const PreviewUpdateInProcess = Layer.effect(
  PreviewUpdate,
  Effect.gen(function* () {
    const deps = yield* makeDeps;

    return Effect.fn("Paykit.PreviewUpdate")(function* (account) {
      return Effect.fn("Paykit.PreviewUpdate.account")(function* (request) {
        return yield* previewUpdateWith(deps, account, request);
      });
    });
  }),
);
