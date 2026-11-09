import * as Schema from "effect/Schema";
import { PlanId } from "./Plan.ts";
import { PlanVersion, TopUpThreshold } from "./Tier.ts";

/** The account a deployment bills. */
export const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));

export type CustomerId = typeof CustomerId.Type;

/** One plan a customer holds, and the status the deployment sees. */
export const CustomerPlan = Schema.Struct({
  planId: PlanId,
  /**
   * The catalog generation the customer holds. A deploy that changes the plan
   * bumps it; this row keeps the generation it was sold at (ADR 0047).
   */
  version: PlanVersion,
  status: Schema.Literals(["trialing", "active", "grace", "canceled", "expired"]),
  scheduledPlanId: Schema.optionalKey(PlanId),
});

export type CustomerPlan = typeof CustomerPlan.Type;

/**
 * A customer's own auto top-up line. The pack, the cooldown and the retry
 * budget stay plan facts: a customer states when a refill is bought, not what
 * it costs or how often it may be charged. `enabled: false` switches the
 * standing plan's line off for this customer without a deploy (ADR 0038).
 */
export const CustomerAutoTopUp = Schema.Struct({
  /** Off switches the line off, even when the plan states one. */
  enabled: Schema.Boolean,
  /**
   * The pool at or below which a spend buys the pack. Omitted keeps the plan's
   * threshold; a control that states one brings a line to a plan that has none.
   */
  threshold: Schema.optionalKey(TopUpThreshold),
});

export type CustomerAutoTopUp = typeof CustomerAutoTopUp.Type;

/**
 * A money ceiling on one feature for one period, in the standing's currency.
 * It is enforced in addition to the plan item's `cap` and `moneyCap`: a
 * customer can spend less than the catalog allows, never more. A ceiling may be
 * lowered under money already billed; it stops new spend and never unbills
 * history.
 */
export const CustomerSpendLimit = Schema.Struct({
  featureId: Schema.String,
  /** Minor units this feature may bill in one period. `0` refuses every billed unit. */
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type CustomerSpendLimit = typeof CustomerSpendLimit.Type;

/**
 * A usage threshold for one feature. It records evidence when the period's
 * usage reaches it and never refuses anything: an alert is a page, not a
 * ceiling (ADR 0038).
 */
export const CustomerUsageAlert = Schema.Struct({
  featureId: Schema.String,
  /** The period's unit count at which the alert fires. */
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type CustomerUsageAlert = typeof CustomerUsageAlert.Type;

/**
 * The controls a customer states over its plan's terms. They are state on the
 * customer, not catalog data: a support agent can lower a ceiling or move a
 * refill line without a deploy, and the event log records what was in force
 * when each spend happened.
 *
 * `SetBillingControls` normalizes and replaces this object as a whole, so
 * replaying the log reconstructs exactly what the customer asked for at each
 * point.
 */
export const BillingControls = Schema.Struct({
  /** The customer's auto top-up line, when it differs from the plan's. */
  autoTopUp: Schema.optionalKey(CustomerAutoTopUp),
  /** At most one money ceiling per feature. */
  spendLimits: Schema.optionalKey(Schema.Array(CustomerSpendLimit)),
  /** Several thresholds for one feature are legal; one `(feature, at)` is not. */
  usageAlerts: Schema.optionalKey(Schema.Array(CustomerUsageAlert)),
});

export type BillingControls = typeof BillingControls.Type;

/**
 * The object in its one representation: limits sorted by feature, alerts by
 * `(feature, at)`, empty arrays dropped and an empty object collapsed to
 * `undefined`. Two callers that listed features in a different order write the
 * same event, and the same guardrail written twice writes none (ADR 0038 §7).
 */
export const normalizeBillingControls = (
  billingControls: BillingControls | undefined,
): BillingControls | undefined => {
  if (billingControls === undefined) return undefined;

  const spendLimits = [...(billingControls.spendLimits ?? [])].sort((left, right) =>
    left.featureId < right.featureId ? -1 : left.featureId > right.featureId ? 1 : 0,
  );

  const usageAlerts = [...(billingControls.usageAlerts ?? [])].sort((left, right) =>
    left.featureId === right.featureId
      ? left.at - right.at
      : left.featureId < right.featureId
        ? -1
        : 1,
  );

  const autoTopUp =
    billingControls.autoTopUp === undefined
      ? undefined
      : {
          enabled: billingControls.autoTopUp.enabled,
          ...(billingControls.autoTopUp.threshold === undefined
            ? {}
            : { threshold: billingControls.autoTopUp.threshold }),
        };

  const normalized = {
    ...(autoTopUp === undefined ? {} : { autoTopUp }),
    ...(spendLimits.length === 0 ? {} : { spendLimits }),
    ...(usageAlerts.length === 0 ? {} : { usageAlerts }),
  };

  return Object.keys(normalized).length === 0 ? undefined : normalized;
};

/** A stable key for a whole controls object, so an equal write records nothing. */
export const controlsKey = (billingControls: BillingControls | undefined): string =>
  JSON.stringify(normalizeBillingControls(billingControls) ?? null);

/**
 * A child scope under one customer: a team, a project, a workspace. It is a
 * scope of the customer's aggregate, not a second customer — it has its own plan
 * set and its own balance sources, and no second event stream (ADR 0040 §1–3).
 * An id is never reused after the entity is archived.
 */
export const EntityId = Schema.String.pipe(Schema.brand("EntityId"));

export type EntityId = typeof EntityId.Type;

/**
 * Where an entity is in its life. `detached` is the absence of a record, not a
 * status: an entity the log never created has no record to read.
 * `archived` is terminal — a new entity is a new id (ADR 0040 §7).
 */
export const EntityStatus = Schema.Literals(["attached", "archived"]);

export type EntityStatus = typeof EntityStatus.Type;

/** The customer-visible record of one entity. Plans and balances stay off it. */
export const Entity = Schema.Struct({
  id: EntityId,
  /** The customer this scope belongs to; the hierarchy is one level. */
  parentId: CustomerId,
  name: Schema.optionalKey(Schema.String),
  status: EntityStatus,
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type Entity = typeof Entity.Type;

/**
 * The scope a balance, a command or a transfer names. A bare string cannot stand
 * in for a customer or an entity by accident, and `{ kind: "customer" }` is the
 * scope every caller meant before entities existed (ADR 0040 §1).
 */
export const ScopeRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("customer") }),
  Schema.Struct({ kind: Schema.Literal("entity"), entityId: EntityId }),
]);

export type ScopeRef = typeof ScopeRef.Type;

/** The customer's own scope, the shape an absent `entityId` means. */
export const CUSTOMER_SCOPE: ScopeRef = { kind: "customer" };

/** The scope one entity names. */
export const entityScope = (entityId: EntityId): ScopeRef => ({ kind: "entity", entityId });

/** The entity id a scope names, or `undefined` for the customer scope. */
export const scopeEntityId = (scope: ScopeRef | undefined): EntityId | undefined =>
  scope?.kind === "entity" ? scope.entityId : undefined;

/** What a customer is, before its balances are folded in. */
export const Customer = Schema.Struct({
  id: CustomerId,
  name: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  plans: Schema.Array(CustomerPlan),
  billingControls: Schema.optionalKey(BillingControls),
  /** Every entity this customer ever attached, archived ones included. */
  entities: Schema.Array(Entity),
});

export type Customer = typeof Customer.Type;
