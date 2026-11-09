import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { isFlagGrant } from "../../src/Allowance.ts";
import { balanceOfEntity } from "../../src/Balance.ts";
import { evaluateCheck } from "../../src/Check.ts";
import { EntityId } from "../../src/Customer.ts";
import {
  BillingState,
  initialBillingState,
  type BillingStateView,
} from "../../src/Subscription/BillingState.view.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "../../src/Subscription/Entitlements.view.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  allowancesOf,
  currencyOf,
  entityOf,
  entityRecordsOf,
  intervalOf,
  pendingPlanOf,
  planIdOf,
  pooledOf,
  pooledRemainingOf,
  priceOf,
  ratesOf,
  initialSubscriptionState,
  billedOf,
  remainingOf,
  reservedCreditsOf,
  reservedOf,
  scopeStateOf,
  standingOf,
  usedOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";
import {
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  propertyAccount,
  Script,
  start,
  type CommandPlan,
} from "./Arbitraries.ts";

type Event = Readonly<{ readonly _tag: string }>;

const handlers = Entitlements.definition.evolve as unknown as Record<
  string,
  (state: EntitlementsState, event: Event, context: unknown) => EntitlementsState
>;

const billingHandlers = BillingState.definition.evolve as unknown as Record<
  string,
  (state: BillingStateView, event: Event, context: unknown) => BillingStateView
>;

/** Fold one accepted decision into the view the read path answers from. */
const foldView = (view: EntitlementsState, events: ReadonlyArray<Event>): EntitlementsState =>
  events.reduce<EntitlementsState>((current, event) => {
    const handler = handlers[event._tag];

    return handler === undefined
      ? current
      : handler(current, event, { key: { id: propertyAccount } });
  }, view);

const foldBilling = (view: BillingStateView, events: ReadonlyArray<Event>): BillingStateView =>
  events.reduce<BillingStateView>((current, event) => {
    const handler = billingHandlers[event._tag];

    return handler === undefined
      ? current
      : handler(current, event, { key: { id: propertyAccount } });
  }, view);

const sameDate = (left: DateTime.Utc | undefined, right: DateTime.Utc | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/**
 * The billing page is the same log folded again, and must report the same
 * tier, standing, money and dunning count. A page that trails the state is a
 * support ticket waiting to happen.
 */
const billingMatchesState = (state: SubscriptionState, view: BillingStateView): boolean => {
  if (state._tag !== "Subscribed") return true;

  if (view.account !== propertyAccount) return false;

  if (view.tier !== planIdOf(state)) return false;

  if (view.status !== state.status) return false;

  if (view.credits !== state.credits) return false;

  if (view.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) return false;

  if (view.dunningAttempts !== state.dunningAttempts) return false;

  if (view.interval !== intervalOf(state)) return false;

  if (view.anchorTz !== state.period.anchorTz) return false;

  if (DateTime.toEpochMillis(view.periodStart) !== DateTime.toEpochMillis(state.period.start)) {
    return false;
  }

  if (DateTime.toEpochMillis(view.periodEnd) !== DateTime.toEpochMillis(state.period.end)) {
    return false;
  }

  if (view.currency !== currencyOf(state)) return false;

  if (!sameDate(view.trialEndsAt, state.trialEndsAt)) return false;

  if (!sameDate(view.graceUntil, state.graceUntil)) return false;

  if (JSON.stringify(view.price) !== JSON.stringify(priceOf(state))) return false;

  if (JSON.stringify(view.proration) !== JSON.stringify(state.proration)) return false;

  // A scheduled change is on the page, so a page that trails it offers the wrong
  // action: "withdraw" with nothing to withdraw, or no way to leave a move the
  // account no longer wants.
  if ((view.pendingTier?.tier ?? null) !== (pendingPlanOf(state)?.planId ?? null)) return false;

  if (
    DateTime.toEpochMillis(view.pendingTier?.at ?? DateTime.makeUnsafe(0)) !==
    DateTime.toEpochMillis(pendingPlanOf(state)?.at ?? DateTime.makeUnsafe(0))
  ) {
    return false;
  }

  return view.prorationInvoice === state.prorationInvoice;
};

const Probe = Schema.Struct({
  /** `sso` is a feature no tier grants, so a read and a write must both say no. */
  feature: Schema.Literals(["messages", "ai", "sso"]),
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
  dimension: Schema.optionalKey(Schema.Literals(["default", "gpt-large"])),
});

type Probe = typeof Probe.Type;

const Case = Schema.Struct({ script: Script, probe: Probe });

const inputOf = (probe: Probe) => ({
  account: propertyAccount,
  featureId: probe.feature,
  requiredBalance: probe.amount,
  ...(probe.feature === "ai" && probe.dimension !== undefined
    ? { dimension: probe.dimension }
    : {}),
});

/**
 * The view is a second fold of the same events. It must report the state the
 * aggregate holds, feature by feature: a `check()` that reads a stale `used` or
 * `reserved` is as wrong as a wrong `decide`.
 */
const viewMatchesState = (state: SubscriptionState, view: EntitlementsState): boolean => {
  if (state._tag !== "Subscribed") {
    // A credits-only account has no tier, but a purchase still created the
    // credit features from the catalog's rate cards.
    if (view.credits !== (state.credits ?? 0)) return false;

    for (const feature of Object.keys(state.rates ?? {})) {
      const entry = view.features[feature];

      if (entry === undefined) return false;

      if (entry.remaining !== (state.credits ?? 0)) return false;

      if (entry.used !== (state.usage?.[feature] ?? 0)) return false;
    }

    return true;
  }

  if (view.tier !== planIdOf(state)) return false;

  if (view.status !== state.status) return false;

  if (view.standing !== standingOf(state.status)) return false;

  if (view.credits !== state.credits) return false;

  if (view.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) return false;

  if (view.dunningAttempts !== state.dunningAttempts) return false;

  if (DateTime.toEpochMillis(view.periodStart) !== DateTime.toEpochMillis(state.period.start)) {
    return false;
  }

  if (DateTime.toEpochMillis(view.periodEnd) !== DateTime.toEpochMillis(state.period.end)) {
    return false;
  }

  for (const [feature, allowance] of Object.entries(allowancesOf(state))) {
    const entry = view.features[feature];

    if (entry === undefined) return false;

    if (entry.used !== usedOf(state, feature)) return false;

    if (entry.reserved !== reservedOf(state, feature)) return false;

    if (isFlagGrant(allowance)) {
      if (entry.remaining !== null) return false;
    } else if (entry.remaining !== remainingOf(state, feature)) return false;

    // Money is part of the standing: a read model that reports a bill the state
    // does not hold lets `check()` spend a cap the account already reached.
    if ((entry.billed ?? 0) !== billedOf(state, feature)) return false;
  }

  // A credit-priced feature shares one pool: its `remaining` is the pool less
  // every open hold, and its `reserved` is those holds' credits, not units.
  const heldCredits = reservedCreditsOf(state);

  for (const feature of Object.keys(ratesOf(state))) {
    const entry = view.features[feature];

    if (entry === undefined) return false;

    if (entry.used !== usedOf(state, feature)) return false;

    if (entry.reserved !== heldCredits) return false;

    if (entry.remaining !== state.credits - heldCredits) return false;
  }

  // The judgement the row carries is `check({ amount: 1 })`. Both read the same
  // `capacityOf`, so this pins the row's `allowed` to the read path and its
  // counters to the state the write path folded.
  for (const [feature, entry] of Object.entries(view.features)) {
    const asked = evaluateCheck(view, {
      account: propertyAccount,
      featureId: feature,
      requiredBalance: 1,
    });

    if (asked.allowed !== entry.allowed) return false;

    if (asked.balance.remaining !== entry.remaining) return false;

    if (asked.standing !== view.standing) return false;
  }

  return true;
};

/**
 * The read path and the write path must give one answer. `check()` is
 * advisory, but a caller that is told yes and then refused in the same
 * transaction has been lied to. `decide` applies the rule to the standing and
 * `check()` applies it to a folded view, so this pins the two inputs, not two
 * copies of the rule.
 *
 * A flag is the one deliberate divergence: it is granted (the read says yes)
 * and it is not counted (the write refuses to meter it), so flags are skipped.
 */
const agree = (
  state: SubscriptionState,
  view: EntitlementsState,
  probe: Probe,
  now: DateTime.Utc,
): boolean => {
  if (state._tag === "Subscribed") {
    const allowance = allowancesOf(state)[probe.feature];

    if (allowance !== undefined && isFlagGrant(allowance)) return true;
  }

  const input = inputOf(probe);
  const asked = evaluateCheck(view, input);

  const tracked = decideAt(
    state,
    new TrackUsage({
      feature: probe.feature,
      amount: probe.amount,
      ...("dimension" in input ? { dimension: input.dimension } : {}),
    }),
    now,
    "probe-track",
  );

  if (asked.allowed !== isAccepted(tracked)) return false;

  // A hold is a standing operation; a credits-only account can track its pack
  // but cannot reserve against a period it does not have yet.
  if (state._tag !== "Subscribed") return true;

  const held = decideAt(
    state,
    new Hold({
      holdId: "probe-hold",
      feature: probe.feature,
      amount: probe.amount,
      expiresAt: DateTime.add(now, { days: 1 }),
      ...("dimension" in input ? { dimension: input.dimension } : {}),
    }),
    now,
    "probe-hold",
  );

  return asked.allowed === isAccepted(held);
};

describe("read and write agreement", () => {
  it.effect("check() says yes exactly when the generated command is accepted", () =>
    assertProperty(
      Arbitrary.schema(Case),
      ({ script, probe }) => {
        let state: SubscriptionState = initialSubscriptionState;
        let view = initialEntitlements;
        let billing = initialBillingState;
        let now = start;

        if (!agree(state, view, probe, now)) return false;

        if (!viewMatchesState(state, view)) return false;

        if (!billingMatchesState(state, billing)) return false;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `agreement-${index}`);

          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, now, `agreement-${index}`);
          view = foldView(view, decision);
          billing = foldBilling(billing, decision);

          if (!viewMatchesState(state, view)) return false;

          if (!billingMatchesState(state, billing)) return false;

          if (!agree(state, view, probe, now)) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});

describe("a standing that goes blocked", () => {
  /**
   * The shrunk counterexample the property above found. `allowed` is documented
   * as the answer `check({ amount: 1 })` gives, so a row still saying yes after
   * the standing went `blocked` offers work the write path refuses. Commands
   * that only moved `status` / `standing` used to leave every feature's
   * judgement where the previous period put it.
   */
  it("rejudges every feature on the row, not only on the next write", () => {
    let state: SubscriptionState = initialSubscriptionState;
    let view = initialEntitlements;
    let now = start;

    const script = {
      steps: [
        { command: { _tag: "StartTrial", tier: "free", trialDays: 1 }, advanceDays: 0 },
        { command: { _tag: "EnterGrace" }, advanceDays: 0 },
        { command: { _tag: "Expire" }, advanceDays: 0 },
      ],
    } as const;

    for (const [index, step] of script.steps.entries()) {
      now = DateTime.add(now, { days: step.advanceDays });
      const command = commandOf(step.command, state, now);
      const decision = decideAt(state, command, now, `blocked-${index}`);

      if (!isAccepted(decision)) throw new Error(`${step.command._tag} was refused`);
      state = evolveAt(state, decision, now, `blocked-${index}`);
      view = foldView(view, decision);
    }

    if (state._tag !== "Subscribed" || state.status !== "expired") {
      throw new Error("the script never expired the standing");
    }

    if (view.standing !== "blocked") throw new Error("the row did not go blocked");
    const features = Object.entries(view.features);

    if (features.length === 0) throw new Error("the row carries no features");

    for (const [feature, entry] of features) {
      if (entry.allowed !== false) throw new Error(`the row still allows ${feature}`);

      if (!viewMatchesState(state, view)) throw new Error(`the row disagrees about ${feature}`);
    }
  });
});

/** A feature every generated entity-scoped command can name. */
const ScopeProbe = Schema.Struct({
  feature: Schema.Literals(["messages"]),
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
});

type ScopeProbe = typeof ScopeProbe.Type;

const ScopeCase = Schema.Struct({ script: Script, probe: ScopeProbe });

/** The features a scope holds a source or a counter for. */
const scopeFeatures = (state: SubscriptionState, entityId: EntityId): ReadonlyArray<string> => {
  const scope = scopeStateOf(state, entityId);

  return [
    ...new Set([
      ...Object.keys(allowancesOf(scope)),
      ...Object.keys(scope.remaining),
      ...Object.values(scope.grants ?? {}).map((grant) => grant.feature),
      ...Object.keys(scope.quantities ?? {}),
      ...Object.keys(scope.occupied ?? {}),
    ]),
  ];
};

/**
 * One entity's `Entitlements` row and `Balance` are the same state the
 * aggregate holds, and the row's `allowed` is the answer `check()` gives. An
 * archived scope holds no row and no source; a live one reports its own
 * sources plus the one shared row, never a credit row of its own.
 */
const scopeViewMatchesState = (
  state: SubscriptionState,
  view: EntitlementsState,
  entityId: EntityId,
): boolean => {
  const record = entityOf(state, entityId);
  const entry = view.entities?.[entityId];

  if (record === undefined) return entry === undefined;

  if (entry === undefined) return false;

  if (entry.status !== record.status) return false;

  if (record.status === "archived") {
    if (Object.keys(entry.features).length !== 0) return false;

    if (Object.keys(record.plans).length !== 0) return false;

    if (Object.keys(record.remaining).length !== 0) return false;

    if (Object.keys(record.grants ?? {}).length !== 0) return false;

    if (Object.keys(record.quantities ?? {}).length !== 0) return false;

    if (Object.keys(record.occupied ?? {}).length !== 0) return false;

    return true;
  }

  const scope = scopeStateOf(state, entityId);
  const subscribed = state._tag === "Subscribed" ? state : undefined;

  for (const [feature, row] of Object.entries(entry.features)) {
    // Credits are one pool per customer: an entity has no credit row.
    if (row.creditRates !== undefined) return false;

    // A seat's row is a purchase and an occupancy, not a spendable count.
    if (row.kind === "non_consumable") continue;

    if (row.remaining !== remainingOf(scope, feature)) return false;

    if (row.used !== usedOf(scope, feature)) return false;

    if ((row.reserved ?? 0) !== 0) return false;

    if ((row.billed ?? 0) !== (subscribed === undefined ? 0 : billedOf(subscribed, feature))) {
      return false;
    }

    const asked = evaluateCheck(view, {
      account: propertyAccount,
      entityId,
      featureId: feature,
      requiredBalance: 1,
    });

    if (row.allowed !== asked.allowed) return false;
  }

  // Every source the scope holds has a row, unless it is already empty.
  for (const feature of scopeFeatures(state, entityId)) {
    if (entry.features[feature] !== undefined) continue;

    const own = remainingOf(scope, feature);
    const occupied = scope.occupied?.[feature] ?? 0;

    if (own !== 0 && own !== null) return false;

    if (usedOf(scope, feature) !== 0) return false;

    if (occupied !== 0) return false;
  }

  // The scoped balance is the scope's own sources plus the one shared row.
  for (const feature of scopeFeatures(state, entityId)) {
    const balance = balanceOfEntity(view, entityId, feature);
    const own = remainingOf(scope, feature);
    const pool = subscribed === undefined ? null : pooledRemainingOf(subscribed, feature);
    const expected = own === null ? null : own + (pool ?? 0);

    if (balance === null) {
      if (expected !== 0 && expected !== null) return false;
      continue;
    }

    if (balance.scope.kind !== "entity" || balance.scope.entityId !== entityId) return false;

    if (balance.remaining !== expected) return false;

    const pooledRows = balance.breakdown.filter((source) => source.pooled === true);

    if (subscribed !== undefined && pooledOf(subscribed, feature)) {
      if (pooledRows.length !== 1) return false;

      if (pooledRows[0]?.remaining !== pool) return false;
    } else if (pooledRows.length !== 0) {
      return false;
    }
  }

  return true;
};

/**
 * The write path and the read path must give one answer for a scope, not only
 * for the customer. `decide` reads the aggregate's scope record; `check()`
 * reads that scope's folded row and `Balance`. A scoped `TrackUsage` is the
 * probe because it is the command the generated scripts already scope.
 */
const scopeAgrees = (
  state: SubscriptionState,
  view: EntitlementsState,
  entityId: EntityId,
  probe: ScopeProbe,
  now: DateTime.Utc,
): boolean => {
  const asked = evaluateCheck(view, {
    account: propertyAccount,
    entityId,
    featureId: probe.feature,
    requiredBalance: probe.amount,
  });

  const tracked = decideAt(
    state,
    new TrackUsage({ feature: probe.feature, amount: probe.amount, entity: entityId }),
    now,
    `scope-probe-${entityId}`,
  );

  return asked.allowed === isAccepted(tracked);
};

/**
 * The fixture every per-scope script starts from: a free customer and two
 * entities, each with a free plan of its own. A generated script then has a
 * real scope to spend, transfer or archive instead of spending the run proving
 * that an unknown id is refused.
 */
const seededScopes = () => {
  let state: SubscriptionState = initialSubscriptionState;
  let view = initialEntitlements;
  const now = start;

  const apply = (plan: CommandPlan, id: string): void => {
    const command = commandOf(plan, state, now);
    const decision = decideAt(state, command, now, id);

    if (!isAccepted(decision)) throw new Error(`the scope seed ${id} was refused`);
    state = evolveAt(state, decision, now, id);
    view = foldView(view, decision);
  };

  apply({ _tag: "Subscribe", tier: "free" }, "scope-seed-subscribe");
  apply({ _tag: "AttachEntity", entityId: "ent-a" }, "scope-seed-attach-a");
  apply({ _tag: "AttachEntity", entityId: "ent-b" }, "scope-seed-attach-b");
  apply({ _tag: "ChangeTier", tier: "free", entityId: "ent-a" }, "scope-seed-plan-a");
  apply({ _tag: "ChangeTier", tier: "free", entityId: "ent-b" }, "scope-seed-plan-b");

  return { state, view, now };
};

describe("per-scope agreement", () => {
  it.effect("an entity's decide, row, balance and allowed agree with its scope", () =>
    assertProperty(
      Arbitrary.schema(ScopeCase),
      ({ script, probe }) => {
        const seeded = seededScopes();
        let state: SubscriptionState = seeded.state;
        let view = seeded.view;
        let now = seeded.now;

        const scopesAgree = (): boolean =>
          entityRecordsOf(state).every(
            (record) =>
              scopeViewMatchesState(state, view, record.id) &&
              scopeAgrees(state, view, record.id, probe, now),
          );

        if (!scopesAgree()) return false;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `scope-${index}`);

          // The generated command that names a scope must answer what that
          // scope's read says, before the decision is folded.
          if (step.command._tag === "TrackUsage" && step.command.entityId !== undefined) {
            const entity = (command as unknown as { readonly entity?: EntityId }).entity;

            if (entity !== undefined) {
              const asked = evaluateCheck(view, {
                account: propertyAccount,
                entityId: entity,
                featureId: "messages",
                requiredBalance: step.command.amount,
              });

              // An accepted empty decision is a deduped retry: it records
              // nothing, so it is not a capacity acceptance to compare.
              const deduped = isAccepted(decision) && decision.length === 0;

              if (!deduped && asked.allowed !== isAccepted(decision)) return false;
            }
          }

          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, now, `scope-${index}`);
          view = foldView(view, decision);

          if (!viewMatchesState(state, view)) return false;

          if (!scopesAgree()) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});
