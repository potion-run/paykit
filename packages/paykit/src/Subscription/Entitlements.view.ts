import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AllowanceKind,
  Included,
  Overage,
  Resets,
  UnitPrice,
  isQuantityGrant,
  pricingOf,
  unitPriceKey,
} from "../Allowance.ts";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { BillingControls, EntityId, EntityStatus } from "../Customer.ts";
import { RateCard } from "../Feature.ts";
import { PricedLine, Pricing, soleUnitPriceOf } from "../Pricing.ts";
import { Proration } from "../Proration.ts";
import { capacityOf, type JudgedFeature } from "./Allowance.verdict.ts";
import {
  Plans,
  mergeAllowances,
  mergeRates,
  planOrder,
  withoutGroup,
  withPlan,
  type PlanRow,
} from "./PlanSet.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import {
  SubscriptionStatus,
  Standing,
  includedRemainingOf,
  recordedCount,
} from "./Subscription.state.ts";

/**
 * The units a period recorded at one price. Two entries mean the standing's unit
 * price changed mid-period, and the close reports each one separately: the
 * vendor prices what it is told, so telling it only the standing's price would
 * reprice everything recorded before the change.
 */
export const PricedUnits = Schema.Struct({
  unitPrice: UnitPrice,
  quantity: Schema.Int,
});

export type PricedUnits = typeof PricedUnits.Type;

/** One standalone grant as a read model carries it. */
export const BalanceGrantView = Schema.Struct({
  id: Schema.String,
  granted: Schema.Int,
  remaining: Schema.Int,
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type BalanceGrantView = typeof BalanceGrantView.Type;

/**
 * One plan's part of a feature's grant. A balance reports one row per plan that
 * grants the feature, so two plans that include the same units cannot be
 * reported as one merged count (ADR 0035 §4, ADR 0039 §2).
 */
export const PlanSourceView = Schema.Struct({
  planId: Schema.String,
  /** The group the plan fills; absent means the default group. */
  group: Schema.optionalKey(Schema.String),
  /** Whether the plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
  /** What this plan includes of the feature. */
  included: Included,
  /** The interval this plan's part resets on. */
  resets: Resets,
});

export type PlanSourceView = typeof PlanSourceView.Type;

/** What a tier grants, what has been used, and when it resets. */
export const FeatureEntitlement = Schema.Struct({
  /**
   * `metered` counts and `flag` does not. Absent means `metered`, so a view
   * recorded before the field existed still reads.
   */
  kind: Schema.optionalKey(AllowanceKind),
  /**
   * The rate card of a credit-priced feature: credits per unit by dimension.
   * Present exactly when the feature is priced in credits, in which case
   * `remaining` is the account's shared pool and there is no `included`.
   */
  creditRates: Schema.optionalKey(RateCard),
  /**
   * What the tier includes: a count, or `"unlimited"`. `null` for a
   * credit-priced feature, which includes no units of its own.
   */
  included: Schema.NullOr(Included),
  used: Schema.Int,
  /** Held by open reservations: out of `remaining`, not yet `used`. */
  reserved: Schema.Int,
  /** Spendable now. `null` means there is no count: an unlimited allowance or a flag. */
  remaining: Schema.NullOr(Schema.Int),
  /**
   * How much of `remaining` rolled over from the period that just closed, at
   * most `included`. `0` when this period is the first or the allowance does
   * not carry — so a console can say "1,480 of 2,000 included, 700 rolled
   * over".
   */
  carried: Schema.Int,
  /**
   * Whether the account may use one more unit right now: the same judgement
   * `check({ amount: 1 })` makes, carried in the read model so an agent reading
   * this view gets the answer without doing the arithmetic.
   */
  allowed: Schema.Boolean,
  overage: Overage,
  /**
   * The units this period may bill past `included` before the ceiling stops
   * it, so a console can say "2,000 of 12,000 used this period". Absent means
   * no cap.
   */
  cap: Schema.optionalKey(Schema.Int),
  resets: Resets,
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
  /** What one billed unit costs, when the allowance is postpaid and has one rate. */
  unitPrice: Schema.optionalKey(UnitPrice),
  /** How a billed unit is priced, when the allowance is postpaid. */
  pricing: Schema.optionalKey(Pricing),
  /** The most this feature may bill in money this period, in minor units. */
  moneyCap: Schema.optionalKey(Schema.Int),
  /** Money billed for this feature this period, in the standing's currency. */
  billed: Schema.optionalKey(Schema.Int),
  /** The customer's money ceiling for this feature this period, in minor units. */
  spendLimit: Schema.optionalKey(Schema.Int),
  /**
   * The quantity a non-consumable feature holds. A seat is set, not spent, so
   * this is the number the account bought (including the free grant).
   */
  quantity: Schema.optionalKey(Schema.Int),
  /**
   * The units this period recorded, keyed by the price they were recorded at.
   * Absent for a feature with no unit price, and on a view written before the
   * close began splitting its report.
   */
  priced: Schema.optionalKey(Schema.Record(Schema.String, PricedUnits)),
  /**
   * The standalone grants behind this feature's balance. The plan and rollover
   * are spent first, so a grant is the last money a customer can spend.
   */
  grants: Schema.optionalKey(Schema.Array(BalanceGrantView)),
  /**
   * Whether the customer's item for this feature is pooled: one shared source
   * every attached entity draws on. Only the customer's own row can carry it
   * (ADR 0040 §3–4).
   */
  pooled: Schema.optionalKey(Schema.Boolean),
  /**
   * The plans that grant this feature, one entry each, in the plan set's order.
   * A `Balance` reads one source per entry instead of one merged plan count.
   */
  planSources: Schema.optionalKey(Schema.Array(PlanSourceView)),
});

export type FeatureEntitlement = typeof FeatureEntitlement.Type;

/**
 * One entity's scope as the read model carries it: its lifecycle and its own
 * feature rows. The shared pool is not copied here — a `Balance` for the scope
 * appends the customer's one pooled row (ADR 0040 §4).
 */
export const EntityEntitlement = Schema.Struct({
  id: EntityId,
  name: Schema.optionalKey(Schema.String),
  status: EntityStatus,
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The scope's own plan set, so its feature rows can name their plans. */
  plans: Schema.optionalKey(Plans),
  features: Schema.Record(Schema.String, FeatureEntitlement),
});

export type EntityEntitlement = typeof EntityEntitlement.Type;

/** Every entity under one customer, keyed by entity id. */
export const EntityEntitlements = Schema.Record(Schema.String, EntityEntitlement);

export type EntityEntitlements = typeof EntityEntitlements.Type;

/** The `check()` read model: per-feature remaining and the account's standing. */
export const EntitlementsState = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  status: SubscriptionStatus,
  standing: Standing,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  cancelAtPeriodEnd: Schema.Boolean,
  credits: Schema.Int,
  /**
   * The part of the pool a one-off purchase bought. It is a lifetime balance
   * source, so a `Balance` reports it separately from the plan's own grant and
   * never expires it with the plan.
   */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /** Payment failures recorded for this standing, including a policy retry. */
  dunningAttempts: Schema.Int,
  /** The money the last tier change moved, and the invoice it was billed on. */
  proration: Schema.optionalKey(Proration),
  prorationInvoice: Schema.optionalKey(Schema.String),
  currency: Schema.optionalKey(Schema.String),
  /**
   * The next boundary of every allowance that runs on its own schedule. Absent
   * for a feature that follows the standing's period, whose boundary is
   * `periodEnd`.
   */
  resetAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.DateTimeUtc)),
  /**
   * The controls the customer states over its plan. A `Balance` reads the spend
   * ceiling from here, so `check` and `track` report the headroom the customer
   * actually has (ADR 0038).
   */
  billingControls: Schema.optionalKey(BillingControls),
  /** The account's plan set, one row per active plan (ADR 0039). */
  plans: Schema.optionalKey(Plans),
  /** The customer's own scope rows. */
  features: Schema.Record(Schema.String, FeatureEntitlement),
  /**
   * Every entity's own rows, keyed by entity id. An entity is a partition of
   * this one read model, not a second key: a read for it filters this map
   * (ADR 0040 §2).
   */
  entities: Schema.optionalKey(EntityEntitlements),
});

export type EntitlementsState = typeof EntitlementsState.Type;

/** One event's billable units added to the price it was recorded at. */
const pricedAfter = (
  current: Readonly<Record<string, PricedUnits>> | undefined,
  line: { readonly key: string; readonly unitPrice: UnitPrice; readonly quantity: number },
) => ({
  ...current,
  [line.key]: {
    unitPrice: line.unitPrice,
    quantity: (current?.[line.key]?.quantity ?? 0) + line.quantity,
  },
});

/** The lines an event recorded, falling back to its one-rate fields. */
const linesOfEvent = (event: {
  readonly priced?: ReadonlyArray<PricedLine>;
  readonly unitPrice?: UnitPrice;
  readonly billable?: number;
}): ReadonlyArray<{ key: string; unitPrice: UnitPrice; quantity: number }> =>
  event.priced !== undefined
    ? event.priced.map((line) => ({
        key: line.key,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
      }))
    : event.unitPrice === undefined || event.billable === undefined
      ? []
      : [
          {
            key: unitPriceKey(event.unitPrice),
            unitPrice: event.unitPrice,
            quantity: event.billable,
          },
        ];

const epoch = DateTime.makeUnsafe(0);

/** The entity rows a view holds, or an empty map for a state written before one. */
const entityMap = (view: EntitlementsState): EntityEntitlements => view.entities ?? {};

/** Replace one entity's rows, leaving its lifecycle and every other scope alone. */
const withEntityFeatures = (
  view: EntitlementsState,
  entityId: string,
  features: Readonly<Record<string, FeatureEntitlement>>,
): EntitlementsState => {
  const entity = entityMap(view)[entityId];

  if (entity === undefined) return view;

  return {
    ...view,
    entities: { ...view.entities, [entityId]: { ...entity, features } },
  };
};

/** Move one feature row of one entity. */
const withEntityFeature = (
  view: EntitlementsState,
  entityId: string,
  feature: string,
  update: (value: FeatureEntitlement | undefined) => FeatureEntitlement,
): EntitlementsState => {
  const entity = entityMap(view)[entityId];

  if (entity === undefined) return view;

  return withEntityFeatures(view, entityId, {
    ...entity.features,
    [feature]: update(entity.features[feature]),
  });
};

/** Set the customer's pooled row's remaining to the pool the event recorded. */
const withPoolRow = (
  view: EntitlementsState,
  feature: string,
  remaining: number,
): EntitlementsState => {
  const value = view.features[feature];

  if (value === undefined) return view;

  return { ...view, features: { ...view.features, [feature]: { ...value, remaining } } };
};

/** The row a scope starts with when a transfer credits a feature it never had. */
const rowFromTransfer = (
  event: { readonly feature: string; readonly amount: number; readonly interval: string },
  grant: FeatureEntitlement["grants"],
): FeatureEntitlement => ({
  included: 0,
  used: 0,
  reserved: 0,
  remaining: event.amount,
  carried: 0,
  allowed: true,
  overage: "block",
  resets: "never",
  resetsAt: null,
  ...(grant === undefined ? {} : { grants: grant }),
});

export const initialEntitlements: EntitlementsState = {
  account: "",
  tier: "",
  status: "expired",
  standing: "blocked",
  periodStart: epoch,
  periodEnd: epoch,
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
  features: {},
  entities: {},
};

type ViewContext = { readonly key: { readonly id: string } };

const withAccount = (view: EntitlementsState, context: ViewContext): EntitlementsState => ({
  ...view,
  account: context.key.id,
});

/**
 * The read `check()` answers from. It folds one account's events, so a
 * cross-account dashboard is `BillingRead`, never this view.
 *
 * Guarded by `Session`: an account reads only itself, an admin reads any.
 */
export class Entitlements extends Domain.View("Entitlements", {
  from: [Subscription],
  key: Subscription,
  state: EntitlementsState,
  initial: initialEntitlements,
  middleware: [Session],
  rejects: [Forbidden],
  validate: Effect.fn(function* ({ key }) {
    const actor = yield* Actor;

    if (!mayActOn(actor, key.id)) {
      return yield* new Forbidden({
        account: key.id,
        actor: actor.id,
        kind: actor.kind,
        scope: "account",
      });
    }
  }),
  evolve: {
    // An entity is a partition of this read model: its lifecycle is one entry,
    // and its rows are what a scoped `Balance` reads (ADR 0040 §2).
    EntityAttached: (view, event, context): EntitlementsState =>
      withAccount(
        entityMap(view)[event.entity] === undefined
          ? {
              ...view,
              entities: {
                ...view.entities,
                [event.entity]: {
                  id: event.entity,
                  ...(event.name === undefined ? {} : { name: event.name }),
                  status: "attached",
                  createdAt: event.at,
                  features: {},
                },
              },
            }
          : view,
        context,
      ),
    EntityUpdated: (view, event, context): EntitlementsState => {
      const entity = entityMap(view)[event.entity];

      if (entity === undefined) return withAccount(view, context);
      const { name: _previous, ...rest } = entity;

      return withAccount(
        {
          ...view,
          entities: {
            ...view.entities,
            [event.entity]: {
              ...rest,
              ...(event.name === undefined ? {} : { name: event.name }),
            },
          },
        },
        context,
      );
    },
    // An archived scope holds nothing: its rows are cleared and the record stays
    // for the bills that name it. The customer's sources gained the sweep in the
    // aggregate; the read model needs the same move.
    EntityArchived: (view, event, context): EntitlementsState => {
      const entity = entityMap(view)[event.entity];

      if (entity === undefined) return withAccount(view, context);

      const features = { ...view.features };

      for (const returned of event.returned) {
        const current = features[returned.feature];

        features[returned.feature] =
          current === undefined
            ? {
                ...rowFromTransfer(
                  {
                    feature: returned.feature,
                    amount: returned.amount,
                    interval: returned.interval,
                  },
                  undefined,
                ),
                remaining: returned.amount,
                resets: returned.interval === "never" ? "never" : "month",
              }
            : {
                ...current,
                remaining: (current.remaining ?? 0) + returned.amount,
              };
      }

      return withAccount(
        {
          ...view,
          features,
          entities: {
            ...view.entities,
            [event.entity]: {
              ...entity,
              status: "archived",
              archivedAt: event.at,
              features: {},
            },
          },
        },
        context,
      );
    },
    // One event, both scopes: the source's own count falls, the target's rises,
    // and a lifetime part arrives as a grant with its deadline.
    BalanceTransferred: (view, event, context): EntitlementsState => {
      const writeScope = (
        current: EntitlementsState,
        scope: typeof event.from,
        remaining: number,
        update: (value: FeatureEntitlement | undefined) => FeatureEntitlement,
      ): EntitlementsState =>
        scope.kind === "customer"
          ? {
              ...current,
              features: {
                ...current.features,
                [event.feature]: update(current.features[event.feature]),
              },
            }
          : withEntityFeature(current, scope.entityId, event.feature, update);

      const sourceRow = (value: FeatureEntitlement | undefined): FeatureEntitlement =>
        value === undefined
          ? rowFromTransfer(
              { feature: event.feature, interval: event.interval, amount: event.fromAfter },
              undefined,
            )
          : { ...value, remaining: event.fromAfter };

      const targetRow = (value: FeatureEntitlement | undefined): FeatureEntitlement => {
        const grants =
          event.grant <= 0
            ? value?.grants
            : [
                ...(value?.grants ?? []),
                {
                  id: `${event.transferId}:grant`,
                  granted: event.grant,
                  remaining: event.grant,
                  ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
                },
              ];

        return value === undefined
          ? rowFromTransfer(
              { feature: event.feature, interval: event.interval, amount: event.toAfter },
              grants,
            )
          : {
              ...value,
              remaining: event.toAfter,
              ...(grants === undefined ? {} : { grants }),
            };
      };

      const debited = writeScope(view, event.from, event.fromAfter, sourceRow);

      return withAccount(writeScope(debited, event.to, event.toAfter, targetRow), context);
    },
    TrialStarted: (view, event, context): EntitlementsState => {
      const plans = { [event.tier]: planRowOf(event) };

      return withAccount(
        {
          ...view,
          tier: event.tier,
          plans,
          status: "trialing",
          standing: "good",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          cancelAtPeriodEnd: false,
          dunningAttempts: 0,
          credits: event.credits,
          prepaidCredits: event.prepaidCredits ?? 0,
          ...(event.resetAt === undefined ? {} : { resetAt: event.resetAt }),
          features: featuresOf(
            event.allowances,
            event.rates,
            event.credits,
            // A fresh standing holds nothing; a grant carried from a previous
            // standing is not usage, and `featuresOf` keeps it.
            0,
            view.features,
            event.remaining,
            event.periodEnd,
            "good",
            false,
            event.resetAt,
            view.billingControls,
            plans,
          ),
        },
        context,
      );
    },
    SubscriptionActivated: (view, event, context): EntitlementsState => {
      const plans = { [event.tier]: planRowOf(event) };

      return withAccount(
        {
          ...view,
          tier: event.tier,
          plans,
          status: "active",
          standing: "good",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          cancelAtPeriodEnd: false,
          dunningAttempts: 0,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          credits: event.credits,
          prepaidCredits: event.prepaidCredits ?? 0,
          features: featuresOf(
            event.allowances,
            event.rates,
            event.credits,
            // A fresh standing holds nothing; a grant carried from a previous
            // standing is not usage, and `featuresOf` keeps it.
            0,
            view.features,
            event.remaining,
            event.periodEnd,
            "good",
            false,
            undefined,
            view.billingControls,
            plans,
          ),
        },
        context,
      );
    },
    PlanChanged: (view, event, context): EntitlementsState => {
      // A scope's plan set is its own: the entity's rows are rebuilt from the
      // event and the customer's are untouched (ADR 0040 §3).
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];

        if (entity === undefined) return withAccount(view, context);

        const plans = withPlan(entity.plans, planRowOf(event));

        const updated = withEntityFeatures(
          view,
          event.entity,
          featuresOf(
            mergeAllowances(plans),
            mergeRates(plans),
            view.credits,
            heldOf(entity.features),
            entity.features,
            event.remaining,
            view.periodEnd,
            view.standing,
            true,
            event.resetAt,
            view.billingControls,
            plans,
          ),
        );

        const row = updated.entities?.[event.entity];

        return withAccount(
          {
            ...updated,
            entities: {
              ...updated.entities,
              [event.entity]: { ...(row ?? entity), plans },
            },
          },
          context,
        );
      }

      // A new tier change replaces what the old one owed and the invoice that
      // settled it; carrying either forward would report stale money.
      const { proration: _previous, prorationInvoice: _invoiced, ...rest } = view;
      const plans = withPlan(view.plans, planRowOf(event));

      return withAccount(
        {
          ...rest,
          tier: event.tier,
          plans,
          credits: event.credits,
          prepaidCredits: event.prepaidCredits ?? 0,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          resetAt: event.resetAt ?? {},
          features: featuresOf(
            mergeAllowances(plans),
            mergeRates(plans),
            // The pool the event records. A mid-period change carries the
            // balance over, so this is the same number it already held; a change
            // applied at the boundary grants the new period's pool, and reading
            // the old balance here would leave every credit feature reporting a
            // pool the new tier never had.
            event.credits,
            heldOf(view.features),
            view.features,
            event.remaining,
            view.periodEnd,
            view.standing,
            true,
            event.resetAt,
            view.billingControls,
            plans,
          ),
          ...(event.proration === undefined ? {} : { proration: event.proration }),
        },
        context,
      );
    },
    UsageRecorded: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];

        if (entity === undefined) return withAccount(view, context);
        const feature = entity.features[event.feature];

        const grants =
          feature === undefined ? undefined : grantsAfterUsage(feature.grants, event.grantsUsed);

        // A scope with no row of its own can still draw the shared pool: the
        // event then moves the customer's one row and only that.
        if (feature === undefined) {
          return withAccount(
            event.poolAfter === undefined
              ? view
              : withPoolRow(view, event.feature, event.poolAfter),
            context,
          );
        }

        const updated = withEntityFeature(view, event.entity, event.feature, (value) => {
          const row = value ?? feature;

          return {
            ...row,
            used: event.usedAfter,
            remaining: event.remainingAfter,
            ...(grants === undefined ? {} : { grants: [...grants] }),
            allowed: allowsOne(
              view.standing,
              judgedOf(row, { used: event.usedAfter, remaining: event.remainingAfter }),
            ),
          };
        });

        // A draw on the shared pool moves the customer's one row, never a copy.
        return withAccount(
          event.poolAfter === undefined
            ? updated
            : withPoolRow(updated, event.feature, event.poolAfter),
          context,
        );
      }

      const feature = view.features[event.feature];

      if (feature === undefined) return withAccount(view, context);

      // A credit-priced feature spends the shared pool, so it moves the balance
      // and leaves `remaining` to the pool helper; a counted feature moves its
      // own counter.
      if (feature.creditRates !== undefined) {
        const spent = withCreditsOf(view, event.creditsAfter, heldOf(view.features));

        return withAccount(
          {
            ...spent,
            prepaidCredits: Math.max(0, Math.min(view.prepaidCredits ?? 0, event.creditsAfter)),
            features: {
              ...spent.features,
              [event.feature]: { ...spent.features[event.feature]!, used: event.usedAfter },
            },
          },
          context,
        );
      }

      return withAccount(
        {
          ...view,
          credits: event.creditsAfter,
          prepaidCredits: Math.max(0, Math.min(view.prepaidCredits ?? 0, event.creditsAfter)),
          features: {
            ...view.features,
            [event.feature]: (() => {
              const billed = event.billedAfter ?? feature.billed ?? 0;

              const grants = grantsAfterUsage(feature.grants, event.grantsUsed);

              return {
                ...feature,
                used: event.usedAfter,
                remaining: event.remainingAfter,
                ...(grants === undefined ? {} : { grants: [...grants] }),
                ...(event.billedAfter === undefined ? {} : { billed: event.billedAfter }),
                ...(linesOfEvent(event).length === 0
                  ? {}
                  : {
                      priced: linesOfEvent(event).reduce(
                        (fold, line) => pricedAfter(fold, line),
                        feature.priced,
                      ),
                    }),
                allowed: allowsOne(
                  view.standing,
                  judgedOf(feature, {
                    billed,
                    used: event.usedAfter,
                    remaining: event.remainingAfter,
                  }),
                ),
              };
            })(),
          },
        },
        context,
      );
    },
    // A hold leaves `remaining` at hold time, so `check()` refuses a second
    // caller the unit the first one holds. `reserved` is the fold of the open
    // holds, not a counter a command writes.
    UsageReserved: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];

      if (feature === undefined) return withAccount(view, context);

      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, heldOf(view.features) + event.cost),
          context,
        );
      }

      const grants = grantsAfterUsage(feature.grants, event.grantsUsed);

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              reserved: feature.reserved + event.amount,
              remaining: event.remainingAfter,
              ...(grants === undefined ? {} : { grants: [...grants] }),
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, {
                  reserved: feature.reserved + event.amount,
                  remaining: event.remainingAfter,
                }),
              ),
            },
          },
        },
        context,
      );
    },
    // The collocated `UsageRecorded` already applied the usage; this closes the
    // hold and returns whatever it did not bill.
    UsageSettled: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];

      if (feature === undefined) return withAccount(view, context);

      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, Math.max(0, heldOf(view.features) - event.cost)),
          context,
        );
      }

      const grants = grantsAfterReturn(feature.grants, event.grantsReturned);

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              // The hold closes in this command, so what it released leaves
              // `reserved` as well as what it billed.
              reserved: Math.max(0, feature.reserved - event.amount - event.released),
              remaining: event.remainingAfter,
              ...(grants === undefined ? {} : { grants: [...grants] }),
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, {
                  reserved: Math.max(0, feature.reserved - event.amount - event.released),
                  remaining: event.remainingAfter,
                }),
              ),
            },
          },
        },
        context,
      );
    },
    UsageReleased: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];

      if (feature === undefined) return withAccount(view, context);

      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, Math.max(0, heldOf(view.features) - event.cost)),
          context,
        );
      }

      const grants = grantsAfterReturn(feature.grants, event.grantsReturned);

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              reserved: Math.max(0, feature.reserved - event.amount),
              remaining: event.remainingAfter,
              ...(grants === undefined ? {} : { grants: [...grants] }),
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, {
                  reserved: Math.max(0, feature.reserved - event.amount),
                  remaining: event.remainingAfter,
                }),
              ),
            },
          },
        },
        context,
      );
    },
    PaymentFailed: (view, event, context): EntitlementsState =>
      withAccount(
        { ...withStanding(view, "grace", "grace"), dunningAttempts: event.attempt },
        context,
      ),
    // A retry is a policy trigger, not a fact this read model shows: the
    // failure that follows it moves `dunningAttempts`.
    DunningRetryDue: (view, _event, context): EntitlementsState => withAccount(view, context),
    GraceEntered: (view, _event, context): EntitlementsState =>
      withAccount(withStanding(view, "grace", "grace"), context),
    PaymentRecorded: (view, _event, context): EntitlementsState =>
      withAccount({ ...withStanding(view, "active", "good"), dunningAttempts: 0 }, context),
    Recovered: (view, _event, context): EntitlementsState =>
      withAccount({ ...withStanding(view, "active", "good"), dunningAttempts: 0 }, context),
    SubscriptionExpired: (view, _event, context): EntitlementsState =>
      withAccount(withStanding(view, "expired", "blocked"), context),
    SubscriptionCanceled: (view, event, context): EntitlementsState =>
      withAccount(
        withStanding({ ...view, periodEnd: event.canceledAt }, "canceled", "blocked"),
        context,
      ),
    PeriodClosed: (view, event, context): EntitlementsState =>
      withAccount(
        withStanding(
          {
            ...view,
            ...(event.statusAfter === "canceled" || event.statusAfter === "expired"
              ? event.cancelAtPeriodEndAfter
                ? {}
                : { plans: {}, tier: "" }
              : {}),
            periodStart: event.nextPeriodStart,
            periodEnd: event.nextPeriodEnd,
            ...(event.credits === undefined ? {} : { credits: event.credits }),
            ...(event.prepaidCredits === undefined ? {} : { prepaidCredits: event.prepaidCredits }),
            cancelAtPeriodEnd: event.cancelAtPeriodEndAfter,
            features: Object.fromEntries(
              Object.entries(view.features).map(([feature, value]) => [
                feature,
                {
                  ...value,
                  resetsAt:
                    value.resets === "never"
                      ? null
                      : (view.resetAt?.[feature] ?? event.nextPeriodEnd),
                },
              ]),
            ),
          },
          event.statusAfter,
          event.standingAfter,
        ),
        context,
      ),
    QuantityChanged: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];
        const feature = entity?.features[event.feature];

        if (entity === undefined || feature === undefined) return withAccount(view, context);

        const remaining = event.quantityAfter - feature.used;

        return withAccount(
          withEntityFeatures(view, event.entity, {
            ...entity.features,
            [event.feature]: {
              ...feature,
              quantity: event.quantityAfter,
              remaining,
              allowed: allowsOne(
                view.standing,
                judgedQuantityOf(feature, event.quantityAfter, remaining),
              ),
            },
          }),
          context,
        );
      }

      const feature = view.features[event.feature];

      if (feature === undefined || feature.kind !== "non_consumable") {
        return withAccount(view, context);
      }

      // A purchase change moves `quantity` and leaves occupancy alone, so the
      // balance may go negative when the purchase drops below the people in use.
      const remaining = event.quantityAfter - feature.used;

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              quantity: event.quantityAfter,
              remaining,
              allowed: allowsOne(
                view.standing,
                judgedQuantityOf(feature, event.quantityAfter, remaining),
              ),
            },
          },
        },
        context,
      );
    },
    UsageSet: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];
        const feature = entity?.features[event.feature];

        if (entity === undefined || feature === undefined) return withAccount(view, context);

        return withAccount(
          withEntityFeatures(view, event.entity, {
            ...entity.features,
            [event.feature]: {
              ...feature,
              used: event.occupiedAfter,
              remaining: event.remainingAfter,
              allowed: allowsOne(
                view.standing,
                judgedQuantityOf(feature, feature.quantity ?? 0, event.remainingAfter),
              ),
            },
          }),
          context,
        );
      }

      const feature = view.features[event.feature];

      if (feature === undefined || feature.kind !== "non_consumable") {
        return withAccount(view, context);
      }

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              used: event.occupiedAfter,
              remaining: event.remainingAfter,
              allowed: allowsOne(
                view.standing,
                judgedQuantityOf(feature, feature.quantity ?? 0, event.remainingAfter),
              ),
            },
          },
        },
        context,
      );
    },
    QuantityProrationInvoiced: (view, _event, context): EntitlementsState =>
      withAccount(view, context),
    BalanceGranted: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];

        if (entity === undefined) return withAccount(view, context);
        const existing = entity.features[event.feature];

        const grant = {
          id: event.grantId,
          granted: event.granted,
          remaining: event.granted,
          ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
        };

        const feature: FeatureEntitlement =
          existing === undefined
            ? {
                included: 0,
                used: 0,
                reserved: 0,
                remaining: event.remainingAfter,
                carried: 0,
                allowed: true,
                overage: "block",
                resets: "never",
                resetsAt: null,
                grants: [grant],
              }
            : {
                ...existing,
                remaining: event.remainingAfter,
                grants: [...(existing.grants ?? []), grant],
                allowed: allowsOne(
                  view.standing,
                  judgedOf(existing, { remaining: event.remainingAfter }),
                ),
              };

        return withAccount(
          withEntityFeatures(view, event.entity, {
            ...entity.features,
            [event.feature]: feature,
          }),
          context,
        );
      }

      const existing = view.features[event.feature];

      const grant = {
        id: event.grantId,
        granted: event.granted,
        remaining: event.granted,
        ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      };

      const feature: FeatureEntitlement =
        existing === undefined
          ? {
              included: 0,
              used: 0,
              reserved: 0,
              remaining: event.remainingAfter,
              carried: 0,
              allowed: allowsOne(
                view.standing,
                judgedOf(
                  {
                    overage: "block",
                    included: 0,
                    remaining: event.remainingAfter,
                    resets: "never",
                    resetsAt: null,
                    used: 0,
                    reserved: 0,
                    carried: 0,
                    allowed: true,
                  },
                  { remaining: event.remainingAfter },
                ),
              ),
              overage: "block",
              resets: "never",
              resetsAt: null,
              grants: [grant],
            }
          : {
              ...existing,
              remaining: event.remainingAfter,
              grants: [...(existing.grants ?? []), grant],
              allowed: allowsOne(
                view.standing,
                judgedOf(existing, { remaining: event.remainingAfter }),
              ),
            };

      return withAccount(
        { ...view, features: { ...view.features, [event.feature]: feature } },
        context,
      );
    },
    BalanceExpired: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];
        const feature = entity?.features[event.feature];

        if (entity === undefined || feature === undefined) return withAccount(view, context);

        const grants = (feature.grants ?? []).filter((grant) => grant.id !== event.grantId);
        const { grants: _previousGrants, ...rest } = feature;

        return withAccount(
          withEntityFeatures(view, event.entity, {
            ...entity.features,
            [event.feature]: {
              ...rest,
              remaining: event.balanceAfter,
              ...(grants.length === 0 ? {} : { grants }),
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, { remaining: event.balanceAfter }),
              ),
            },
          }),
          context,
        );
      }

      const feature = view.features[event.feature];

      if (feature === undefined) return withAccount(view, context);

      const grants = (feature.grants ?? []).filter((grant) => grant.id !== event.grantId);
      const { grants: _previousGrants, ...rest } = feature;

      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...rest,
              remaining: event.balanceAfter,
              ...(grants.length === 0 ? {} : { grants }),
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, { remaining: event.balanceAfter }),
              ),
            },
          },
        },
        context,
      );
    },
    PlanItemReset: (view, event, context): EntitlementsState => {
      if (event.entity !== undefined) {
        const entity = entityMap(view)[event.entity];
        const feature = entity?.features[event.feature];

        if (entity === undefined || feature === undefined) return withAccount(view, context);

        if (feature.kind === "non_consumable") return withAccount(view, context);

        const { priced: _priced, billed: _billed, ...carried } = feature;

        return withAccount(
          withEntityFeatures(view, event.entity, {
            ...entity.features,
            [event.feature]: {
              ...carried,
              used: 0,
              reserved: 0,
              remaining: event.remaining,
              carried: event.carried,
              resetsAt: event.resetAt,
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, {
                  used: 0,
                  reserved: 0,
                  remaining: event.remaining,
                  billed: 0,
                  carried: event.carried,
                }),
              ),
            },
          }),
          context,
        );
      }

      const feature = view.features[event.feature];

      if (feature === undefined || feature.kind === "non_consumable") {
        return withAccount(view, context);
      }

      const { priced: _priced, billed: _billed, ...carried } = feature;
      const { [event.feature]: _previous, ...resetAt } = view.resetAt ?? {};

      return withAccount(
        {
          ...view,
          ...(event.resetAt === null
            ? {}
            : { resetAt: { ...resetAt, [event.feature]: event.resetAt } }),
          features: {
            ...view.features,
            [event.feature]: {
              ...carried,
              used: 0,
              reserved: 0,
              remaining: event.remaining,
              carried: event.carried,
              resetsAt: event.resetAt,
              allowed: allowsOne(
                view.standing,
                judgedOf(feature, {
                  used: 0,
                  reserved: 0,
                  remaining: event.remaining,
                  billed: 0,
                  carried: event.carried,
                }),
              ),
            },
          },
        },
        context,
      );
    },
    UsageReset: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => {
              // A credit-priced feature has no allowance to reset: the pool is
              // shared, and only this feature's spend in the period restarts.
              // Open holds are cleared by the reset too, so the spendable pool
              // is the whole balance again. A period pool expires in the next
              // event and updates this through `withCreditsOf`.
              if (value.creditRates !== undefined) {
                return [
                  feature,
                  {
                    ...value,
                    used: 0,
                    reserved: 0,
                    remaining: view.credits,
                    allowed: allowsOne(
                      view.standing,
                      judgedOf(value, { used: 0, reserved: 0, remaining: view.credits }),
                    ),
                  },
                ];
              }

              // `resets: "never"` keeps its usage and open reservations: the
              // boundary moves the period, not this allowance.
              const kept = event.kept?.[feature] === true;
              // An allowance with no count resets to `null` again: usage returns
              // to zero, but an unlimited allowance and a flag still have no
              // number to report.
              const recorded = recordedCount(event.remaining, feature);
              const spendable = recorded === undefined ? includedRemainingOf(value) : recorded;
              // A boundary clears the money a feature billed. `resets: "never"`
              // keeps it, exactly as it keeps `used` and the `priced` split: the
              // feature is still accounting for the period that did not end for
              // it. The reset follows `kept` and not whether the allowance in
              // force has a `unitPrice`: a tier change can move a feature that
              // billed this period onto an allowance that states no price, and
              // the counter belongs to the period, not to the new allowance.
              const { priced: recordedPrices, billed: recordedBilled, ...carried } = value;
              const billed = kept ? recordedBilled : undefined;

              return [
                feature,
                {
                  ...carried,
                  ...(kept && recordedPrices !== undefined ? { priced: recordedPrices } : {}),
                  used: kept ? value.used : 0,
                  reserved: kept ? value.reserved : 0,
                  remaining: spendable,
                  carried: event.carried[feature] ?? 0,
                  ...(billed === undefined ? {} : { billed }),
                  allowed: allowsOne(
                    view.standing,
                    judgedOf(value, {
                      billed: billed ?? 0,
                      used: kept ? value.used : 0,
                      remaining: spendable,
                      carried: event.carried[feature] ?? 0,
                    }),
                  ),
                },
              ];
            }),
          ),
        },
        context,
      ),
    // A scheduled change is a fact about the next period, so it moves nothing
    // now: the counters and `remaining` stay the current tier's until the close
    // applies the change and resets them onto the new allowances.
    PlanChangeScheduled: (view, _event, context): EntitlementsState => withAccount(view, context),
    // A group's cancellation moves nothing until its boundary; the plan set is
    // still the account's to use. The close that resolves it emits the
    // `PlanChanged` or `PlanGroupCanceled` this view reads.
    GroupCancellationScheduled: (view, _event, context): EntitlementsState =>
      withAccount(view, context),
    GroupCancellationWithdrawn: (view, _event, context): EntitlementsState =>
      withAccount(view, context),
    PlanGroupCanceled: (view, event, context): EntitlementsState => {
      const plans = withoutGroup(view.plans ?? {}, event.group);

      const remaining = Object.fromEntries(
        Object.entries(view.features).map(([feature, value]) => [feature, value.remaining]),
      );

      return withAccount(
        {
          ...view,
          plans,
          features: featuresOf(
            mergeAllowances(plans),
            mergeRates(plans),
            view.credits,
            heldOf(view.features),
            view.features,
            remaining,
            view.periodEnd,
            view.standing,
            true,
            view.resetAt,
            view.billingControls,
            plans,
          ),
        },
        context,
      );
    },
    // A withdrawal moves nothing the account may use: the tier it is on, its
    // counters and its pool are the ones the schedule was going to leave behind.
    TierChangeWithdrawn: (view, _event, context): EntitlementsState => withAccount(view, context),
    CancellationScheduled: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, cancelAtPeriodEnd: true }, context),
    CancellationWithdrawn: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, cancelAtPeriodEnd: false }, context),
    TrialExtended: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          periodEnd: event.periodEnd,
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => [
              feature,
              {
                ...value,
                resetsAt: value.resets === "never" ? null : event.periodEnd,
              },
            ]),
          ),
        },
        context,
      ),
    CreditsGranted: (view, event, context): EntitlementsState =>
      withAccount(withPool(view, event.balanceAfter), context),
    CreditsPurchased: (view, event, context): EntitlementsState => {
      const pooled = withPool(view, event.balanceAfter);
      const rates = event.rates;

      if (rates === undefined) return withAccount(pooled, context);

      // A purchase before any plan is the one time the view has a pool but no
      // tier to describe it. The event carries the catalog's rate cards, so the
      // features exist and `check()` can price them; a credits-only account is
      // spendable (`standing: good`) while it has credits.
      const standing =
        pooled.tier === "" && pooled.plans === undefined && event.balanceAfter > 0
          ? "good"
          : pooled.standing;

      const held = heldOf(pooled.features);
      const features = { ...pooled.features };

      for (const [feature, card] of Object.entries(rates)) {
        features[feature] = creditFeatureOf(
          card,
          event.balanceAfter,
          held,
          features[feature],
          standing,
        );
      }

      return withAccount(
        { ...pooled, prepaidCredits: event.prepaidAfter, standing, features },
        context,
      );
    },
    CreditsConsumed: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...withPool(view, event.balanceAfter),
          prepaidCredits: Math.max(0, Math.min(view.prepaidCredits ?? 0, event.balanceAfter)),
        },
        context,
      ),
    CreditsExpired: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...withPool(view, event.balanceAfter),
          prepaidCredits: Math.max(0, Math.min(view.prepaidCredits ?? 0, event.balanceAfter)),
        },
        context,
      ),
    ProviderRefAttached: (view, _event, context): EntitlementsState => withAccount(view, context),
    // A cooldown bounds the deployment's spending, not what the account may use:
    // the pool and every counter are untouched. The view still emits it so the
    // read-model projection sees the whole log.
    TopUpCooldownCleared: (view, _event, context): EntitlementsState => withAccount(view, context),
    // A control changes what a spend is judged against, not a count: each row's
    // `allowed` is rebuilt so a console and `decide` keep agreeing on it.
    BillingControlsSet: (view, event, context): EntitlementsState => {
      const { billingControls: _previous, ...rest } = view;

      return withAccount(
        {
          ...rest,
          ...(event.billingControls === undefined
            ? {}
            : { billingControls: event.billingControls }),
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => [
              feature,
              withSpendLimit(view.standing, feature, value, event.billingControls),
            ]),
          ),
        },
        context,
      );
    },
    // An alert is evidence: no feature's count, allowance or pool moves.
    UsageAlertFired: (view, _event, context): EntitlementsState => withAccount(view, context),
    // A refill that could not be bought moved no credit: the pool and every
    // counter are exactly where the crossing left them. The view still emits it
    // so the read-model projection sees the whole log.
    // A rung is a trigger the policy acts on: it grants nothing and moves no
    // counter, but the view emits it so the read-model projection sees the
    // whole log (ADR 0031).
    TopUpRetryDue: (view, _event, context): EntitlementsState => withAccount(view, context),
    TopUpFailed: (view, _event, context): EntitlementsState => withAccount(view, context),
    // Money going back is not an entitlement: the pool and every counter are
    // untouched (revoking credits is a separate `ConsumeCredits`). The view
    // still emits it so the read-model projection sees the whole log.
    RefundRecorded: (view, _event, context): EntitlementsState => withAccount(view, context),
    // Money coming back is money, not an entitlement: the pool is untouched, so
    // the view only emits it for the read-model projection (ADR 0030).
    RefundReversed: (view, _event, context): EntitlementsState => withAccount(view, context),
    // Billing an upgrade moves money, not an entitlement; the view still emits
    // it so the read-model projection sees the whole log.
    ProrationInvoiced: (view, event, context): EntitlementsState =>
      withAccount({ ...view, prorationInvoice: event.invoiceId }, context),
  },
}) {}

/**
 * Move the shared pool, and with it every credit-priced feature's `remaining`.
 * One balance, so the features cannot report different ones.
 */
const withPool = (view: EntitlementsState, balance: number): EntitlementsState =>
  withCreditsOf(view, balance, heldOf(view.features));

/** The facts a judgement reads, from a row's feature and the movement being applied. */
const judgedOf = (
  value: FeatureEntitlement,
  over: {
    readonly billed?: number;
    readonly used?: number;
    readonly reserved?: number;
    readonly remaining?: number | null;
    readonly carried?: number;
  } = {},
): JudgedFeature => ({
  overage: value.overage,
  included: value.included,
  ...(value.cap === undefined ? {} : { cap: value.cap }),
  carried: over.carried ?? value.carried,
  ...(value.moneyCap === undefined ? {} : { moneyCap: value.moneyCap }),
  ...(value.spendLimit === undefined ? {} : { spendLimit: value.spendLimit }),
  ...(value.pricing === undefined ? {} : { pricing: value.pricing }),
  billed: over.billed ?? value.billed ?? 0,
  used: over.used ?? value.used,
  reserved: over.reserved ?? value.reserved,
  remaining: over.remaining === undefined ? value.remaining : over.remaining,
  ...(value.creditRates === undefined ? {} : { creditRates: value.creditRates }),
});

/** The judgement facts for a quantity: a cap, not a spendable count. */
const judgedQuantityOf = (
  feature: {
    readonly overage: Overage;
    readonly included: Included | null;
    readonly cap?: number;
  },
  quantity: number,
  remaining: number | null,
): JudgedFeature => ({
  overage: feature.overage,
  included: feature.included,
  ...(feature.cap === undefined ? {} : { cap: feature.cap }),
  carried: 0,
  billed: 0,
  used: quantity,
  reserved: 0,
  remaining,
  quantity,
});

/** The same facts for an allowance the view is building, before a row exists. */
const judgedAllowanceOf = (
  allowance: {
    readonly overage: Overage;
    readonly included: Included;
    readonly cap?: number;
    readonly pricing?: Pricing;
    readonly moneyCap?: number;
  },
  over: {
    readonly remaining: number | null;
    readonly used: number;
    readonly reserved: number;
    readonly billed: number;
    readonly spendLimit?: number;
  },
): JudgedFeature => ({
  overage: allowance.overage,
  included: allowance.included,
  ...(allowance.cap === undefined ? {} : { cap: allowance.cap }),
  carried: 0,
  ...(allowance.moneyCap === undefined ? {} : { moneyCap: allowance.moneyCap }),
  ...(over.spendLimit === undefined ? {} : { spendLimit: over.spendLimit }),
  ...(allowance.pricing === undefined ? {} : { pricing: allowance.pricing }),
  billed: over.billed,
  used: over.used,
  reserved: over.reserved,
  remaining: over.remaining,
});

/**
 * Whether one more unit is allowed, from the standing and the feature's facts.
 *
 * The read model's name for {@link capacityOf} at `amount: 1`, so the row's
 * `allowed` and `check()` cannot disagree. A `null` remaining is unbounded, so
 * it always has room for one more, however large the pool is.
 */
export const allowsOne = (standing: Standing, feature: JudgedFeature): boolean =>
  capacityOf({ standing, feature, ask: { amount: 1 } })._tag === "Allowed";

/** Deduct an event's grant allocation from a feature's grant list. */
const grantsAfterUsage = (
  grants: ReadonlyArray<BalanceGrantView> | undefined,
  used: Readonly<Record<string, number>> | undefined,
): ReadonlyArray<BalanceGrantView> | undefined => {
  if (used === undefined) return grants;

  return (grants ?? []).map((grant) => {
    const amount = used[grant.id];

    return amount === undefined
      ? grant
      : { ...grant, remaining: Math.max(0, grant.remaining - amount) };
  });
};

/** Return a release's grant allocation to a feature's grant list. */
const grantsAfterReturn = (
  grants: ReadonlyArray<BalanceGrantView> | undefined,
  returned: Readonly<Record<string, number>> | undefined,
): ReadonlyArray<BalanceGrantView> | undefined => {
  if (returned === undefined) return grants;

  return (grants ?? []).map((grant) => {
    const amount = returned[grant.id];

    return amount === undefined
      ? grant
      : { ...grant, remaining: Math.min(grant.granted, grant.remaining + amount) };
  });
};

/**
 * A feature's spendable count: the outcome an event recorded, or what the
 * allowance has when the event does not mention the feature. `null` is no
 * count at all: an unlimited allowance, or a flag's grant.
 */
const spendableOf = (
  recorded: Readonly<Record<string, number | null>>,
  feature: string,
  allowance: {
    readonly included: Included | null;
    readonly overage: Overage;
    readonly resets: Resets;
  },
): number | null => {
  const remaining = recordedCount(recorded, feature);

  // `undefined` is "this event says nothing about the feature"; `null` is a
  // recorded absence of a count, and must survive as one.
  if (remaining !== undefined) return remaining;

  return includedRemainingOf(allowance);
};

/** The credits open holds keep out of the pool: one number, shared. */
const heldOf = (features: Readonly<Record<string, FeatureEntitlement>>): number => {
  for (const value of Object.values(features)) {
    if (value.creditRates !== undefined) return value.reserved;
  }

  return 0;
};

/**
 * A credit-priced feature's read model: the rate card, the shared pool minus
 * what open holds keep out of it, and the holds themselves.
 */
const creditFeatureOf = (
  rates: RateCard,
  credits: number,
  held: number,
  previous: FeatureEntitlement | undefined,
  standing: Standing,
  keepUsage = true,
): FeatureEntitlement => ({
  creditRates: rates,
  included: null,
  used: keepUsage ? (previous?.used ?? 0) : 0,
  // One pool, so every credit-priced feature reports the same held credits.
  reserved: held,
  remaining: credits - held,
  carried: 0,
  // "One more unit" is `check({ amount: 1 })`, which costs the default rate.
  allowed: allowsOne(standing, {
    overage: "block",
    included: null,
    carried: 0,
    billed: 0,
    used: previous?.used ?? 0,
    reserved: held,
    remaining: credits - held,
    creditRates: rates,
  }),
  overage: "block",
  resets: "never",
  resetsAt: null,
});

/**
 * Rejudge one feature for a standing. `allowed` is documented as the answer
 * `check({ amount: 1 })` gives, and it is carried so a caller reading the row
 * does not have to do the arithmetic — which means every command that moves the
 * standing has to move it too. A row that still says yes after the standing
 * went `blocked` offers work the write path refuses.
 */
const rejudged = (value: FeatureEntitlement, standing: Standing): FeatureEntitlement => ({
  ...value,
  allowed: allowsOne(standing, judgedOf(value)),
});

/** Move the standing, and rejudge every feature against it. */
const withStanding = (
  view: EntitlementsState,
  status: SubscriptionStatus,
  standing: Standing,
): EntitlementsState => ({
  ...view,
  status,
  standing,
  features: Object.fromEntries(
    Object.entries(view.features).map(([feature, value]) => [feature, rejudged(value, standing)]),
  ),
});

/**
 * Move the shared pool and its held credits together, so every credit-priced
 * feature keeps reporting one balance.
 */
const withCreditsOf = (
  view: EntitlementsState,
  credits: number,
  held: number,
): EntitlementsState => ({
  ...view,
  credits,
  features: Object.fromEntries(
    Object.entries(view.features).map(([feature, value]) =>
      value.creditRates === undefined
        ? [feature, value]
        : [feature, creditFeatureOf(value.creditRates, credits, held, value, view.standing)],
    ),
  ),
});

/**
 * One feature row under one controls object: the limit it states, and the
 * `allowed` the limit produces. A row with no limit drops the field, so a
 * cleared control leaves no stale ceiling behind.
 */
const withSpendLimit = (
  standing: Standing,
  feature: string,
  value: FeatureEntitlement,
  billingControls: BillingControls | undefined,
): FeatureEntitlement => {
  const limit = billingControls?.spendLimits?.find((entry) => entry.featureId === feature)?.amount;

  const { spendLimit: _previous, ...rest } = value;
  const next = limit === undefined ? rest : { ...rest, spendLimit: limit };

  return { ...next, allowed: allowsOne(standing, judgedOf(next, {})) };
};

/** The plans that grant one feature, in the plan set's read order. */
const planSourcesOf = (plans: Plans | undefined, feature: string): ReadonlyArray<PlanSourceView> =>
  planOrder(plans).flatMap((row) => {
    const allowance = row.allowances[feature];

    return allowance === undefined
      ? []
      : [
          {
            planId: row.planId,
            ...(row.group === "default" ? {} : { group: row.group }),
            ...(row.addOn ? { addOn: true } : {}),
            included: allowance.included,
            resets: allowance.resets,
          },
        ];
  });

/** The plan row an activation event leaves behind. */
const planRowOf = (event: {
  readonly tier: string;
  readonly group?: string;
  readonly addOn?: boolean;
  readonly allowances: PlanRow["allowances"];
  readonly credits: number;
  readonly planCredits?: number;
  readonly prepaidCredits?: number;
  readonly creditsExpire: PlanRow["creditsExpire"];
  readonly topUp?: PlanRow["topUp"];
  readonly rates: PlanRow["rates"];
  readonly interval?: NonNullable<PlanRow["interval"]>;
  readonly currency?: string;
  readonly price?: NonNullable<PlanRow["price"]>;
}): PlanRow => ({
  planId: event.tier,
  group: event.group ?? "default",
  addOn: event.addOn ?? false,
  allowances: event.allowances,
  credits: event.planCredits ?? event.credits - (event.prepaidCredits ?? 0),
  creditsExpire: event.creditsExpire,
  ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
  rates: event.rates,
  ...(event.interval === undefined ? {} : { interval: event.interval }),
  ...(event.currency === undefined ? {} : { currency: event.currency }),
  ...(event.price === undefined ? {} : { price: event.price }),
});

const featuresOf = (
  allowances: Readonly<
    Record<
      string,
      {
        kind?: AllowanceKind;
        included: Included;
        overage: Overage;
        resets: Resets;
        cap?: number;
        pricing?: Pricing;
        unitPrice?: UnitPrice;
        moneyCap?: number;
        pooled?: boolean;
      }
    >
  >,
  rates: Readonly<Record<string, RateCard>>,
  credits: number,
  held: number,
  previous: Readonly<Record<string, FeatureEntitlement>>,
  remaining: Readonly<Record<string, number | null>>,
  periodEnd: DateTime.Utc,
  standing: Standing,
  keepUsage = false,
  resetAt?: Readonly<Record<string, DateTime.Utc>>,
  billingControls?: BillingControls,
  plans?: Plans,
) => ({
  ...Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      const used = keepUsage ? (previous[feature]?.used ?? 0) : 0;
      const reserved = keepUsage ? (previous[feature]?.reserved ?? 0) : 0;
      const billed = keepUsage ? (previous[feature]?.billed ?? 0) : 0;
      const priced = keepUsage ? previous[feature]?.priced : undefined;

      const planSources = planSourcesOf(plans, feature);

      if (isQuantityGrant(allowance)) {
        const free = typeof allowance.included === "number" ? allowance.included : 0;
        // `quantity` is what the account bought; `used` is what is occupied.
        // A tier change keeps both — it only raises the purchase to a larger
        // free grant — so a seat is never taken away by moving plans.
        const quantity = keepUsage ? Math.max(previous[feature]?.quantity ?? free, free) : free;
        const occupied = keepUsage ? (previous[feature]?.used ?? 0) : 0;
        const quantityRemaining = quantity - occupied;

        return [
          feature,
          {
            kind: "non_consumable",
            included: allowance.included,
            used: occupied,
            reserved: 0,
            remaining: quantityRemaining,
            carried: 0,
            allowed: allowsOne(standing, judgedQuantityOf(allowance, quantity, quantityRemaining)),
            overage: allowance.overage,
            ...(allowance.cap === undefined ? {} : { cap: allowance.cap }),
            ...(pricingOf(allowance) === null ? {} : { pricing: pricingOf(allowance)! }),
            ...(pricingOf(allowance) === null || soleUnitPriceOf(pricingOf(allowance)!) === null
              ? {}
              : { unitPrice: soleUnitPriceOf(pricingOf(allowance)!)! }),
            quantity,
            resets: "never",
            resetsAt: null,
            ...(allowance.pooled === true ? { pooled: true } : {}),
            ...(planSources.length === 0 ? {} : { planSources }),
          },
        ];
      }

      const spendable = spendableOf(remaining, feature, allowance);

      const spendLimit = billingControls?.spendLimits?.find(
        (entry) => entry.featureId === feature,
      )?.amount;

      return [
        feature,
        {
          ...(allowance.kind === undefined ? {} : { kind: allowance.kind }),
          included: allowance.included,
          used,
          reserved,
          remaining: spendable,
          // A period starts with no rollover; only `UsageReset` carries one in.
          carried: 0,
          allowed: allowsOne(
            standing,
            judgedAllowanceOf(allowance, {
              remaining: spendable,
              used,
              reserved,
              billed,
              ...(spendLimit === undefined ? {} : { spendLimit }),
            }),
          ),
          overage: allowance.overage,
          ...(allowance.cap === undefined ? {} : { cap: allowance.cap }),
          ...(pricingOf(allowance) === null ? {} : { pricing: pricingOf(allowance)! }),
          ...(pricingOf(allowance) === null || soleUnitPriceOf(pricingOf(allowance)!) === null
            ? {}
            : { unitPrice: soleUnitPriceOf(pricingOf(allowance)!)! }),
          ...(allowance.moneyCap === undefined ? {} : { moneyCap: allowance.moneyCap }),
          ...(spendLimit === undefined ? {} : { spendLimit }),
          ...(billed === 0 ? {} : { billed }),
          ...(priced === undefined ? {} : { priced }),
          resets: allowance.resets,
          resetsAt: allowance.resets === "never" ? null : (resetAt?.[feature] ?? periodEnd),
          ...(allowance.pooled === true ? { pooled: true } : {}),
          ...(planSources.length === 0 ? {} : { planSources }),
          // A plan change keeps a grant: it belongs to the customer, not to the
          // plan that was active when it was made (ADR 0037).
          ...((previous[feature]?.grants?.length ?? 0) > 0
            ? { grants: previous[feature]!.grants }
            : {}),
        },
      ];
    }),
  ),
  // A credit-priced feature has no allowance, so it is not in the map above:
  // its read model is the rate card and the one pool every such feature shares.
  ...Object.fromEntries(
    Object.entries(rates).map(([feature, card]) => [
      feature,
      creditFeatureOf(card, credits, held, previous[feature], standing, keepUsage),
    ]),
  ),
  // A feature that is only a standalone grant is not in the plan's allowances.
  // It keeps its row — and its grant — across a plan change.
  ...Object.fromEntries(
    Object.entries(previous)
      .filter(
        ([feature, value]) =>
          allowances[feature] === undefined &&
          rates[feature] === undefined &&
          value.kind !== "non_consumable" &&
          (value.grants?.length ?? 0) > 0,
      )
      .map(([feature, value]) => [
        feature,
        keepUsage
          ? value
          : {
              ...value,
              used: 0,
              reserved: 0,
              ...(value.billed === undefined ? {} : { billed: 0 }),
              ...(value.priced === undefined ? {} : { priced: undefined }),
            },
      ]),
  ),
});
