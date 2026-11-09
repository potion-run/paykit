import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { catalog, creditRatesOf, planTermsOf, type Catalog } from "../../src/Catalog.ts";
import { EntityId } from "../../src/Customer.ts";
import { feature, messages } from "../../src/Feature.ts";
import { prorate } from "../../src/Proration.ts";
import { ArchiveEntity } from "../../src/Subscription/ArchiveEntity.command.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { ConsumeCredits } from "../../src/Subscription/ConsumeCredits.command.ts";
import { CreateCustomer } from "../../src/Subscription/CreateCustomer.command.ts";
import { DunningRetry } from "../../src/Subscription/DunningRetry.command.ts";
import { EnterGrace } from "../../src/Subscription/EnterGrace.command.ts";
import { Expire } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial } from "../../src/Subscription/ExtendTrial.command.ts";
import { GraceElapsed } from "../../src/Subscription/GraceElapsed.command.ts";
import { GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { GrantCredits } from "../../src/Subscription/GrantCredits.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { HoldElapsed } from "../../src/Subscription/HoldElapsed.command.ts";
import { PeriodEnded } from "../../src/Subscription/PeriodEnded.command.ts";
import { PurchaseCredits } from "../../src/Subscription/PurchaseCredits.command.ts";
import { RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover } from "../../src/Subscription/Recover.command.ts";
import { ReleaseHold } from "../../src/Subscription/ReleaseHold.command.ts";
import { Resume } from "../../src/Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { SetBillingControls } from "../../src/Subscription/SetBillingControls.command.ts";
import { SetQuantity } from "../../src/Subscription/SetQuantity.command.ts";
import { SettleHold } from "../../src/Subscription/SettleHold.command.ts";
import { SetUsage } from "../../src/Subscription/SetUsage.command.ts";
import { StartTrial } from "../../src/Subscription/StartTrial.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  priceOf as statePriceOf,
  entityRecordsOf,
  initialSubscriptionState,
  scopeStateOf,
  SubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { TransferBalance } from "../../src/Subscription/TransferBalance.command.ts";
import { UpdateEntity } from "../../src/Subscription/UpdateEntity.command.ts";
import { WithdrawTierChange } from "../../src/Subscription/WithdrawTierChange.command.ts";
import { tier } from "../../src/Tier.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });

/** The catalog every generated script runs against. */
export const testCatalog = Effect.runSync(
  catalog({
    features: [messages, ai],
    tiers: [
      tier({ id: "free", credits: 0, grants: [allowance(messages, { included: 100 })] }),
      tier({
        id: "pro",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        credits: 50_000,
        topUp: { threshold: 100 },
        grants: [allowance(messages, { included: 2_000, overage: "bill" })],
      }),
      tier({
        id: "scale",
        price: { amount: 9_900, currency: "usd", interval: "month" },
        credits: 100_000,
        grants: [allowance(messages, { included: 5_000, overage: "block" })],
      }),
      tier({
        id: "unlimited",
        price: { amount: 19_900, currency: "usd", interval: "month" },
        credits: 0,
        grants: [allowance(messages, { included: "unlimited" })],
      }),
      tier({
        id: "carry",
        price: { amount: 2_900, currency: "usd", interval: "month" },
        credits: 5_000,
        grants: [allowance(messages, { included: 100, carryOver: true })],
      }),
      // A capped allowance that also carries what it did not spend: the cap
      // does not grow with the rollover, so a script that closes a period with
      // units left is what exercises the ceiling's `carried` term.
      tier({
        id: "carry-cap",
        price: { amount: 3_400, currency: "usd", interval: "month" },
        credits: 5_000,
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            carryOver: true,
            cap: 20,
            unitPrice: { amount: 1, currency: "usd" },
            moneyCap: 2_000,
          }),
        ],
      }),
      tier({
        id: "prepaid",
        price: { amount: 4_900, currency: "usd", interval: "month" },
        credits: 10_000,
        creditsExpire: "never",
        grants: [allowance(messages, { included: 100 })],
      }),
      // The money tiers. Their allowances are sized against `Amount` (1..500)
      // so a generated script actually bills: a tier whose ceiling sits below a
      // single generated request would be refused on its first step and the
      // money path would never run. `metered` reaches its money ceiling first,
      // `capped` its unit ceiling, and `recurring` bills past a free grant it
      // never resets.
      tier({
        id: "metered",
        price: { amount: 2_900, currency: "usd", interval: "month" },
        credits: 10_000,
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            cap: 2_000,
            unitPrice: { amount: 5, currency: "usd" },
            moneyCap: 4_000,
          }),
        ],
      }),
      tier({
        id: "capped",
        price: { amount: 3_900, currency: "usd", interval: "month" },
        credits: 5_000,
        grants: [
          allowance(messages, {
            included: 50,
            overage: "bill",
            cap: 200,
            unitPrice: { amount: 1, currency: "usd" },
            moneyCap: 100_000,
          }),
        ],
      }),
      // A money ceiling small enough to be passed by ordinary usage, so a
      // generated script can reach a standing that a tier change would put over
      // its money cap. Without one, "no reachable state is past a ceiling"
      // could never be made to fail.
      tier({
        id: "cheap",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        credits: 0,
        grants: [
          allowance(messages, {
            included: 10,
            overage: "bill",
            unitPrice: { amount: 1, currency: "usd" },
            moneyCap: 50,
          }),
        ],
      }),
      // A `resets: "never"` postpaid allowance keeps its use, holds and billed
      // money across a period boundary, so a close must not reset what the
      // standing is still accounting for.
      tier({
        id: "recurring",
        price: { amount: 5_900, currency: "usd", interval: "month" },
        credits: 0,
        grants: [
          allowance(messages, {
            included: 10,
            overage: "bill",
            resets: "never",
            unitPrice: { amount: 2, currency: "usd" },
            moneyCap: 20_000,
          }),
        ],
      }),
    ],
  }),
);

/** The tiers a generated script may choose from. */
export const TierName = Schema.Literals([
  "free",
  "pro",
  "scale",
  "unlimited",
  "carry",
  "carry-cap",
  "prepaid",
  "metered",
  "capped",
  "cheap",
  "recurring",
]);

export type TierName = typeof TierName.Type;

/** The start of every generated script, so time is data, not the wall clock. */
export const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

export const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 })));
export const Days = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 40 })));

export const TrialDays = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
);

export const DedupeKey = Schema.optionalKey(Schema.Literals(["req-a", "req-b", "req-c"]));
export const HoldId = Schema.Literals(["hold-a", "hold-b", "hold-c"]);

/**
 * The identities a generated script may record. Two of them are enough: a
 * repeated draw is the equal-details no-op and the other draw is
 * `CustomerExists` (ADR 0045).
 */
export const CustomerIdentity = Schema.Literals(["ada", "grace"]);

/**
 * The two entities a generated script can name. The ids are fixed rather than
 * generated, so the same plan targets the same scope on every run and a replay
 * is the same event rather than a second entity.
 */
export const EntityPlanId = Schema.Literals(["ent-a", "ent-b"]);

export type EntityPlanId = typeof EntityPlanId.Type;

/** The optional label an attach or a rename carries; absent clears it. */
const EntityName = Schema.optionalKey(Schema.Literals(["team-a", "team-b"]));

/**
 * One high-level command a script may ask for. A plan is converted to the real
 * command against the current state, because some commands carry values only
 * the state can know (a `ChangeTier` proration, a `ClosePeriod` boundary) and a
 * scoped command has to name a scope that exists (an entity attach).
 */
export const CommandPlan = Schema.Union([
  Schema.TaggedStruct("Subscribe", { tier: TierName }),
  Schema.TaggedStruct("StartTrial", { tier: TierName, trialDays: TrialDays }),
  Schema.TaggedStruct("ChangeTier", {
    tier: TierName,
    entityId: Schema.optionalKey(EntityPlanId),
  }),
  Schema.TaggedStruct("TrackUsage", {
    amount: Amount,
    dedupeKey: DedupeKey,
    entityId: Schema.optionalKey(EntityPlanId),
  }),
  Schema.TaggedStruct("TrackCredits", {
    amount: Amount,
    dimension: Schema.Literals(["default", "gpt-large"]),
  }),
  Schema.TaggedStruct("Hold", {
    holdId: HoldId,
    // A hold on `ai` spends the pool, so the generated scripts exercise
    // reservations against credits, not only against a counted allowance.
    feature: Schema.optionalKey(Schema.Literals(["messages", "ai"])),
    amount: Amount,
    dedupeKey: DedupeKey,
  }),
  Schema.TaggedStruct("SettleHold", { holdId: HoldId, amount: Schema.optionalKey(Amount) }),
  Schema.TaggedStruct("ReleaseHold", { holdId: HoldId }),
  Schema.TaggedStruct("HoldElapsed", { holdId: HoldId }),
  Schema.TaggedStruct("GrantBalance", {
    amount: Amount,
    entityId: Schema.optionalKey(EntityPlanId),
  }),
  Schema.TaggedStruct("SetQuantity", {
    quantity: Amount,
    dedupeKey: Schema.optionalKey(Schema.Literals(["qty-a", "qty-b"])),
    entityId: Schema.optionalKey(EntityPlanId),
  }),
  Schema.TaggedStruct("SetUsage", {
    usage: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
    entityId: Schema.optionalKey(EntityPlanId),
  }),
  Schema.TaggedStruct("GrantCredits", { amount: Amount }),
  Schema.TaggedStruct("PurchaseCredits", { amount: Amount }),
  Schema.TaggedStruct("ConsumeCredits", { amount: Amount }),
  Schema.TaggedStruct("RecordPayment", { amount: Amount }),
  Schema.TaggedStruct("RecordPaymentFailure", {}),
  Schema.TaggedStruct("EnterGrace", {}),
  Schema.TaggedStruct("Recover", {}),
  Schema.TaggedStruct("ScheduleCancellation", {}),
  Schema.TaggedStruct("ScheduleTierChange", { tier: TierName }),
  Schema.TaggedStruct("WithdrawTierChange", {}),
  Schema.TaggedStruct("Resume", {}),
  Schema.TaggedStruct("ClosePeriod", {}),
  Schema.TaggedStruct("PeriodEnded", {}),
  Schema.TaggedStruct("Expire", {}),
  Schema.TaggedStruct("ExtendTrial", { trialDays: TrialDays }),
  Schema.TaggedStruct("GraceElapsed", {}),
  Schema.TaggedStruct("DunningRetry", {}),
  Schema.TaggedStruct("AttachProviderRef", {}),
  Schema.TaggedStruct("SetBillingControls", {
    enabled: Schema.Boolean,
    threshold: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  }),
  Schema.TaggedStruct("CreateCustomer", { identity: CustomerIdentity }),
  Schema.TaggedStruct("AttachEntity", { entityId: EntityPlanId, name: EntityName }),
  Schema.TaggedStruct("UpdateEntity", { entityId: EntityPlanId, name: EntityName }),
  Schema.TaggedStruct("ArchiveEntity", { entityId: EntityPlanId }),
  Schema.TaggedStruct("TransferBalance", {
    from: EntityPlanId,
    to: EntityPlanId,
    amount: Amount,
  }),
]);

export type CommandPlan = typeof CommandPlan.Type;

/** A command and how much virtual time passes before it. */
export const ScriptStep = Schema.Struct({
  command: CommandPlan,
  advanceDays: Days,
});

export type ScriptStep = typeof ScriptStep.Type;

/** A generated history: commands in order, with a clock that moves with them. */
export const Script = Schema.Struct({
  steps: Schema.Array(ScriptStep).pipe(Schema.check(Schema.isMaxLength(80))),
});

export type Script = typeof Script.Type;

/** One command's decision: events to commit, or the rejection it returned. */
export type Decision = ReadonlyArray<{ readonly _tag: string }> | { readonly _tag: string };

export const isAccepted = (
  decision: Decision,
): decision is ReadonlyArray<{ readonly _tag: string }> => Array.isArray(decision);

const termsOf = (tierId: TierName) => {
  const found = planTermsOf(testCatalog, tierId);

  if (found === null) throw new Error(`the generated catalog is missing tier ${tierId}`);

  return found;
};

const priceOf = (tierId: TierName) => termsOf(tierId).price;

const entityIdOf = (id: EntityPlanId): EntityId => EntityId.make(id);

/** The entities that exist and have not been archived. */
const liveEntities = (state: SubscriptionState): ReadonlyArray<EntityId> =>
  entityRecordsOf(state)
    .filter((record) => record.status === "attached")
    .map((record) => record.id);

/**
 * The scope a plan names. An id the log already knows is used as it is, so an
 * archived scope still earns its terminal refusal. An id the log never created
 * falls back to a live scope when one exists, because a scoped write has to be
 * able to attach before it writes; with no live scope it stays the plan's id
 * and the model answers `EntityUnknown` rather than the generator crashing.
 */
const scopeIdOf = (
  state: SubscriptionState,
  preferred: EntityPlanId | undefined,
): EntityId | undefined => {
  if (preferred === undefined) return undefined;

  if (state.entities?.[preferred] !== undefined) return entityIdOf(preferred);

  return liveEntities(state)[0] ?? entityIdOf(preferred);
};

/**
 * The pair a generated transfer addresses. Both endpoints are scopes that
 * exist: two live entities when the log has two, the only live entity with
 * itself when it has one (an accepted no-op), and the plan's id when it has
 * none (an `EntityUnknown` refusal, not a second entity).
 */
const transferScopes = (
  state: SubscriptionState,
  plan: { readonly from: EntityPlanId; readonly to: EntityPlanId },
): { readonly from: EntityId; readonly to: EntityId } => {
  const live = liveEntities(state);
  const plannedFrom = entityIdOf(plan.from);
  const plannedTo = entityIdOf(plan.to);

  const from =
    live.includes(plannedFrom) && live.includes(plannedTo) && plan.from !== plan.to
      ? plannedFrom
      : (live[0] ?? plannedFrom);

  const to =
    live.includes(plannedTo) && plannedTo !== from
      ? plannedTo
      : (live.find((id) => id !== from) ?? from);

  return { from, to };
};

const prorationAt = (state: SubscribedState, tierId: TierName, now: DateTime.Utc) => {
  const priced = prorate({
    from: statePriceOf(state),
    to: priceOf(tierId),
    period: { start: state.period.start, end: state.period.end },
    at: now,
  });

  return priced ?? undefined;
};

/** The `ChangeTier` proration the state says a move at `now` would cost. */
export const prorationFor = (state: SubscriptionState, tierId: TierName, now: DateTime.Utc) =>
  state._tag === "Subscribed" ? prorationAt(state, tierId, now) : undefined;

/** Build the real command class for a plan, using only state the model already holds. */
export const commandOf = (
  plan: CommandPlan,
  state: SubscriptionState,
  now: DateTime.Utc,
): { readonly _tag: string } => {
  const graceUntil = DateTime.add(now, { days: 7 });

  switch (plan._tag) {
    case "Subscribe":
      return new Subscribe({ tier: plan.tier, ...termsOf(plan.tier) });
    case "StartTrial":
      return new StartTrial({
        tier: plan.tier,
        ...termsOf(plan.tier),
        trialEndsAt: DateTime.add(now, { days: plan.trialDays }),
      });
    case "ChangeTier": {
      const entity = plan.entityId === undefined ? undefined : scopeIdOf(state, plan.entityId);
      const scoped = entity === undefined ? state : scopeStateOf(state, entity);

      const proration =
        scoped._tag === "Subscribed" ? prorationAt(scoped, plan.tier, now) : undefined;

      return new ChangeTier({
        tier: plan.tier,
        ...termsOf(plan.tier),
        ...(entity === undefined ? {} : { entity }),
        ...(proration === undefined ? {} : { proration }),
      });
    }

    case "TrackUsage": {
      const entity = plan.entityId === undefined ? undefined : scopeIdOf(state, plan.entityId);

      return new TrackUsage({
        feature: "messages",
        amount: plan.amount,
        ...(entity === undefined ? {} : { entity }),
        ...(plan.dedupeKey === undefined ? {} : { dedupeKey: plan.dedupeKey }),
      });
    }

    case "TrackCredits":
      return new TrackUsage({
        feature: "ai",
        amount: plan.amount,
        dimension: plan.dimension,
      });
    case "Hold":
      return new Hold({
        holdId: plan.holdId,
        feature: plan.feature ?? "messages",
        amount: plan.amount,
        expiresAt: DateTime.add(now, { days: 365 }),
        ...(plan.dedupeKey === undefined ? {} : { dedupeKey: plan.dedupeKey }),
      });
    case "SettleHold":
      return new SettleHold({
        holdId: plan.holdId,
        ...(plan.amount === undefined ? {} : { amount: plan.amount }),
      });
    case "ReleaseHold":
      return new ReleaseHold({ holdId: plan.holdId });
    case "HoldElapsed":
      return new HoldElapsed({ holdId: plan.holdId });
    case "GrantBalance": {
      const entity = plan.entityId === undefined ? undefined : scopeIdOf(state, plan.entityId);

      return new GrantBalance({
        feature: "messages",
        granted: plan.amount,
        ...(entity === undefined ? {} : { entity }),
      });
    }

    case "SetQuantity": {
      const entity = plan.entityId === undefined ? undefined : scopeIdOf(state, plan.entityId);

      return new SetQuantity({
        feature: "seats",
        quantity: plan.quantity,
        dedupeKey: plan.dedupeKey ?? "qty-a",
        ...(entity === undefined ? {} : { entity }),
      });
    }

    case "SetUsage": {
      const entity = plan.entityId === undefined ? undefined : scopeIdOf(state, plan.entityId);

      return new SetUsage({
        feature: "seats",
        usage: plan.usage,
        ...(entity === undefined ? {} : { entity }),
      });
    }

    case "GrantCredits":
      return new GrantCredits({ amount: plan.amount });
    case "PurchaseCredits":
      return new PurchaseCredits({
        tier: "credits_1k",
        amount: plan.amount,
        rates: creditRatesOf(testCatalog),
      });
    case "ConsumeCredits":
      return new ConsumeCredits({ amount: plan.amount });
    case "RecordPayment":
      return new RecordPayment({ amount: plan.amount, currency: "usd" });
    case "RecordPaymentFailure":
      return new RecordPaymentFailure({ reason: "card_declined", graceUntil });
    case "EnterGrace":
      return new EnterGrace({ graceUntil });
    case "Recover":
      return new Recover();
    case "ScheduleCancellation":
      return new ScheduleCancellation();
    case "ScheduleTierChange":
      return new ScheduleTierChange({ tier: plan.tier, ...termsOf(plan.tier) });
    case "WithdrawTierChange":
      return new WithdrawTierChange();
    case "Resume":
      return new Resume();
    case "ClosePeriod":
      return new ClosePeriod({
        periodEnd: state._tag === "Subscribed" ? state.period.end : now,
      });
    case "PeriodEnded":
      return new PeriodEnded({
        periodEnd: state._tag === "Subscribed" ? state.period.end : now,
      });
    case "Expire":
      return new Expire();
    case "ExtendTrial":
      return new ExtendTrial({ trialEndsAt: DateTime.add(now, { days: plan.trialDays }) });
    case "GraceElapsed":
      return new GraceElapsed();
    case "DunningRetry": {
      const running = state._tag === "Subscribed" ? state : undefined;
      const startedAt = running?.dunningStartedAt ?? now;

      return new DunningRetry({
        afterAttempt: running?.dunningAttempts ?? 0,
        startedAt,
      });
    }

    case "AttachProviderRef":
      return new AttachProviderRef({ provider: "test", refs: { customer: "cus_property" } });
    case "SetBillingControls":
      return new SetBillingControls({
        billingControls: {
          autoTopUp: {
            enabled: plan.enabled,
            ...(plan.threshold === undefined ? {} : { threshold: plan.threshold }),
          },
        },
        features: {},
      });
    case "CreateCustomer":
      return new CreateCustomer({
        name: plan.identity,
        email: `${plan.identity}@example.com`,
      });
    case "AttachEntity":
      return new AttachEntity({
        entityId: entityIdOf(plan.entityId),
        ...(plan.name === undefined ? {} : { name: plan.name }),
      });
    case "UpdateEntity":
      return new UpdateEntity({
        entityId: entityIdOf(plan.entityId),
        ...(plan.name === undefined ? {} : { name: plan.name }),
      });
    case "ArchiveEntity":
      return new ArchiveEntity({ entityId: entityIdOf(plan.entityId) });
    case "TransferBalance": {
      const scopes = transferScopes(state, plan);

      return new TransferBalance({
        from: { kind: "entity", entityId: scopes.from },
        to: { kind: "entity", entityId: scopes.to },
        feature: "messages",
        amount: plan.amount,
      });
    }
  }
};

const commandId = (index: number) => `cmd-${index}`;

/** The account every generated script runs against. */
export const propertyAccount = "acct_property";

/** Run one command through the aggregate's pure `decide`. */
export const decideAt = (
  state: SubscriptionState,
  command: { readonly _tag: string },
  now: DateTime.Utc,
  id: string,
): Decision =>
  (
    Subscription.definition.decide as unknown as Record<
      string,
      (
        state: SubscriptionState,
        command: unknown,
        ctx: { readonly id: string; readonly commandId: string; readonly now: DateTime.Utc },
      ) => Decision
    >
  )[command._tag]!(state, command, { id: propertyAccount, commandId: id, now });

/** Fold accepted events with their envelope, exactly as the kernel does. */
export const evolveAt = (
  state: SubscriptionState,
  events: ReadonlyArray<{ readonly _tag: string }>,
  now: DateTime.Utc,
  id: string,
): SubscriptionState =>
  events.reduce<SubscriptionState>((current, event, index) => {
    const handler = (
      Subscription.definition.evolve as unknown as Record<
        string,
        (state: SubscriptionState, event: unknown, envelope: unknown) => SubscriptionState
      >
    )[event._tag]!;

    return handler(current, event, {
      id: propertyAccount,
      stream: `Subscription/${propertyAccount}`,
      seq: index + 1,
      at: now,
      commandId: id,
      correlationId: id,
    });
  }, state);

/** Fold a committed log from the empty state. */
export const foldAt = (
  events: ReadonlyArray<{ readonly _tag: string }>,
  now: DateTime.Utc,
): SubscriptionState => evolveAt(initialSubscriptionState, events, now, "cmd-fold");

/** The state a reader compares, encoded through the schema it is stored as. */
export const canonical = (state: SubscriptionState): unknown =>
  Schema.encodeSync(SubscriptionState)(state);

/** A script walked once, with the events it committed and the state it reached. */
export interface Walked {
  readonly state: SubscriptionState;
  readonly events: ReadonlyArray<{ readonly _tag: string }>;
  readonly now: DateTime.Utc;
}

/** Walk a generated script through `decide`/`evolve`, committing only accepted events. */
export const walk = (script: Script): Walked => {
  let state: SubscriptionState = initialSubscriptionState;
  let now = start;
  const events: Array<{ readonly _tag: string }> = [];

  for (const [index, step] of script.steps.entries()) {
    now = DateTime.add(now, { days: step.advanceDays });
    const command = commandOf(step.command, state, now);
    const decision = decideAt(state, command, now, commandId(index));

    if (!isAccepted(decision)) continue;
    events.push(...decision);
    state = evolveAt(state, decision, now, commandId(index));
  }

  return { state, events, now };
};

/** A standing opened by subscribing to `tier`, without walking a script. */
export const subscribedAt = (tier: TierName, now: DateTime.Utc = start): SubscribedState => {
  const decision = decideAt(
    initialSubscriptionState,
    commandOf({ _tag: "Subscribe", tier }, initialSubscriptionState, now),
    now,
    "open",
  );

  if (!isAccepted(decision)) throw new Error(`the fixture catalog could not open ${tier}`);
  const state = evolveAt(initialSubscriptionState, decision, now, "open");

  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");

  return state;
};

/** The same, against a catalog other than the fixture one. */
export const subscribedIn = (
  source: Catalog,
  tier: string,
  now: DateTime.Utc = start,
): SubscribedState => {
  const terms = planTermsOf(source, tier);

  if (terms === null) throw new Error(`the catalog is missing ${tier}`);

  const decision = decideAt(
    initialSubscriptionState,
    new Subscribe({ tier, ...terms }),
    now,
    "open",
  );

  if (!isAccepted(decision)) throw new Error(`the catalog could not open ${tier}`);
  const state = evolveAt(initialSubscriptionState, decision, now, "open");

  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");

  return state;
};

/** The subset of the state a rollover assertion reads. */
export const subscribed = (state: SubscriptionState): SubscribedState => {
  if (state._tag !== "Subscribed") throw new Error("the script never activated a standing");

  return state;
};
