import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { EntityId } from "../../src/Customer.ts";
import { feature, messages } from "../../src/Feature.ts";
import { ArchiveEntity } from "../../src/Subscription/ArchiveEntity.command.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { SetQuantity } from "../../src/Subscription/SetQuantity.command.ts";
import { SetUsage } from "../../src/Subscription/SetUsage.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import {
  entityOf,
  grantTotalOf,
  initialSubscriptionState,
  remainingOf,
  scopeStateOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { TransferBalance } from "../../src/Subscription/TransferBalance.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Days,
  decideAt,
  EntityPlanId,
  evolveAt,
  isAccepted,
  start,
  type EntityPlanId as EntityPlanIdType,
} from "./Arbitraries.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/**
 * A customer with one plan of its own, one pooled item every entity draws on,
 * and a team plan an entity can hold. The tiers are free, so a generated move
 * never needs a proration and the only money in the script is the balance a
 * transfer or an archive moves.
 */
const entityCatalog = Effect.runSync(
  catalog({
    features: [messages, seats],
    tiers: [
      tier({ id: "base", grants: [allowance(seats, { included: 1 })] }),
      tier({
        id: "pool",
        addOn: true,
        grants: [allowance(messages, { included: 100, pooled: true })],
      }),
      tier({
        id: "team",
        grants: [allowance(messages, { included: 50 }), allowance(seats, { included: 2 })],
      }),
    ],
  }),
);

const termsOf = (tierId: "base" | "pool" | "team") => {
  const found = planTermsOf(entityCatalog, tierId);

  if (found === null) throw new Error(`the entity catalog is missing ${tierId}`);

  return found;
};

const entityIdOf = (id: EntityPlanIdType): EntityId => EntityId.make(id);

const entityIds: ReadonlyArray<EntityPlanIdType> = ["ent-a", "ent-b"];

/** The one scope a step names, or `null` when it names none. */
const targetOf = (step: EntityStep): EntityPlanIdType | null => {
  switch (step._tag) {
    case "Attach":
    case "Plan":
    case "Grant":
    case "Spend":
    case "Seat":
    case "Quantity":
    case "Archive":
      return step.entityId;
    case "Transfer":
      return step.from;
    case "Close":
      return null;
  }
};

/** A command from the entity catalog, built against the state it will decide. */
const commandFor = (step: EntityStep, state: SubscriptionState, index: number) => {
  switch (step._tag) {
    case "Attach":
      return new AttachEntity({ entityId: entityIdOf(step.entityId) });
    case "Plan":
      return new ChangeTier({
        tier: "team",
        ...termsOf("team"),
        entity: entityIdOf(step.entityId),
      });
    case "Grant":
      return new GrantBalance({
        feature: "messages",
        granted: step.amount,
        entity: entityIdOf(step.entityId),
      });
    case "Spend":
      return new TrackUsage({
        feature: "messages",
        amount: step.amount,
        entity: entityIdOf(step.entityId),
      });
    case "Seat":
      return new SetUsage({
        feature: "seats",
        usage: step.usage,
        entity: entityIdOf(step.entityId),
      });
    case "Quantity":
      return new SetQuantity({
        feature: "seats",
        quantity: step.quantity,
        dedupeKey: `quantity-${index}`,
        entity: entityIdOf(step.entityId),
      });
    case "Transfer":
      return new TransferBalance({
        from: { kind: "entity", entityId: entityIdOf(step.from) },
        to: { kind: "entity", entityId: entityIdOf(step.to) },
        feature: "messages",
        amount: step.amount,
      });
    case "Archive":
      return new ArchiveEntity({ entityId: entityIdOf(step.entityId) });
    case "Close":
      return new ClosePeriod({
        periodEnd: state._tag === "Subscribed" ? state.period.end : start,
      });
  }
};

const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 80 })));
const Count = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })));

const EntityStep = Schema.Union([
  Schema.TaggedStruct("Attach", { entityId: EntityPlanId }),
  Schema.TaggedStruct("Plan", { entityId: EntityPlanId }),
  Schema.TaggedStruct("Grant", { entityId: EntityPlanId, amount: Amount }),
  Schema.TaggedStruct("Spend", { entityId: EntityPlanId, amount: Amount }),
  Schema.TaggedStruct("Seat", { entityId: EntityPlanId, usage: Count }),
  Schema.TaggedStruct("Quantity", { entityId: EntityPlanId, quantity: Count }),
  Schema.TaggedStruct("Transfer", { from: EntityPlanId, to: EntityPlanId, amount: Amount }),
  Schema.TaggedStruct("Archive", { entityId: EntityPlanId }),
  Schema.TaggedStruct("Close", {}),
]);

type EntityStep = typeof EntityStep.Type;

const EntityScript = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      step: EntityStep,
      advanceDays: Days,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(40))),
});

type EntityScript = typeof EntityScript.Type;

const run = (
  state: SubscriptionState,
  command: { readonly _tag: string },
  now: DateTime.Utc,
  id: string,
): SubscriptionState => {
  const decision = decideAt(state, command, now, id);

  if (!isAccepted(decision)) throw new Error(`the fixture command ${id} was refused`);

  return evolveAt(state, decision, now, id);
};

/**
 * The customer is subscribed, both entities are attached and both hold a team
 * plan, and the customer's messages item is the one shared pool. Every generated
 * script starts here, so a spend, a transfer and an archive all have something
 * real to move rather than spending the whole run proving a missing scope is
 * refused.
 */
const seeded = (): SubscriptionState => {
  let state = run(
    initialSubscriptionState,
    new Subscribe({ tier: "base", ...termsOf("base") }),
    start,
    "seed-open",
  );

  state = run(state, new ChangeTier({ tier: "pool", ...termsOf("pool") }), start, "seed-pool");

  for (const id of entityIds) {
    state = run(state, new AttachEntity({ entityId: entityIdOf(id) }), start, `seed-attach-${id}`);
    state = run(
      state,
      new ChangeTier({ tier: "team", ...termsOf("team"), entity: entityIdOf(id) }),
      start,
      `seed-plan-${id}`,
    );
  }

  return state;
};

const ownOf = (state: SubscriptionState, id: EntityPlanIdType): number =>
  remainingOf(scopeStateOf(state, entityIdOf(id)), "messages") ?? 0;

const poolOf = (state: SubscriptionState): number =>
  remainingOf(scopeStateOf(state), "messages") ?? 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * A scope that was archived holds nothing and is terminal. Its record keeps the
 * lifecycle so a bill can name it, but every source, purchase and seat has left.
 */
const archivedHoldsNothing = (state: SubscriptionState, id: EntityPlanIdType): void => {
  const record = entityOf(state, entityIdOf(id));

  assert(record !== undefined, `${id} has no record after its archive`);
  assert(record.status === "archived", `${id} is not archived`);
  assert(Object.keys(record.plans).length === 0, `${id} still holds a plan`);
  assert(Object.keys(record.remaining).length === 0, `${id} still holds a count`);
  assert(Object.keys(record.grants ?? {}).length === 0, `${id} still holds a grant`);
  assert(Object.keys(record.quantities ?? {}).length === 0, `${id} still holds a purchase`);
  assert(Object.keys(record.occupied ?? {}).length === 0, `${id} still occupies a seat`);

  for (const featureId of ["messages", "seats"]) {
    assert(
      remainingOf(scopeStateOf(state, entityIdOf(id)), featureId) === 0,
      `${id} can still spend ${featureId}`,
    );
    assert(
      grantTotalOf(scopeStateOf(state, entityIdOf(id)), featureId) === 0,
      `${id} still counts a ${featureId} grant`,
    );
  }
};

/**
 * Every scoped command a caller can send to an archived scope is refused by the
 * archive itself, not by a missing plan or a zero balance. The probes are the
 * same commands the script generates, so a path that silently answers an empty
 * decision is a failure here.
 */
const noSpendAfterArchive = (state: SubscriptionState, id: EntityPlanIdType): void => {
  const entity = entityIdOf(id);
  const other = entityIdOf(id === "ent-a" ? "ent-b" : "ent-a");

  const refused = (command: { readonly _tag: string }): boolean => {
    const decision = decideAt(state, command, start, `probe-${command._tag}-${id}`);

    return !isAccepted(decision) && decision._tag === "EntityArchived";
  };

  const commands: ReadonlyArray<{ readonly _tag: string }> = [
    new AttachEntity({ entityId: entity }),
    new ChangeTier({ tier: "team", ...termsOf("team"), entity }),
    new GrantBalance({ feature: "messages", granted: 1, entity }),
    new TrackUsage({ feature: "messages", amount: 1, entity }),
    new SetUsage({ feature: "seats", usage: 1, entity }),
    new SetQuantity({ feature: "seats", quantity: 1, dedupeKey: `probe-${id}`, entity }),
    new TransferBalance({
      from: { kind: "entity", entityId: entity },
      to: { kind: "entity", entityId: other },
      feature: "messages",
      amount: 1,
    }),
    new TransferBalance({
      from: { kind: "entity", entityId: other },
      to: { kind: "entity", entityId: entity },
      feature: "messages",
      amount: 1,
    }),
    new ArchiveEntity({ entityId: entity }),
  ];

  for (const command of commands) {
    assert(refused(command), `${id} accepted ${command._tag} after its archive`);
  }
};

describe("entities in a generated history", () => {
  it.effect("a transfer conserves both scopes' own sources and moves no pool", () =>
    assertProperty(
      Arbitrary.schema(EntityScript),
      (script) => {
        let state = seeded();
        let now = start;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });

          const decision = decideAt(
            state,
            commandFor(step.step, state, index),
            now,
            `entity-${index}`,
          );

          if (!isAccepted(decision)) {
            // A target that was archived is refused by the archive, never by a
            // plan or a balance. Anything else may be a normal refusal: a
            // missing id, an occupied seat, a spend past the sources.
            const target = targetOf(step.step);

            if (target !== null && entityOf(state, entityIdOf(target))?.status === "archived") {
              assert(
                decision._tag === "EntityArchived",
                `${target} answered ${decision._tag} after its archive`,
              );
            }

            continue;
          }

          const before = state;
          state = evolveAt(state, decision, now, `entity-${index}`);

          for (const event of decision) {
            if (event._tag === "EntityArchived") {
              const id = (event as unknown as { readonly entity: EntityPlanIdType }).entity;

              archivedHoldsNothing(state, id);
              noSpendAfterArchive(state, id);
            }

            if (event._tag === "BalanceTransferred") {
              const moved = event as unknown as {
                readonly from: { readonly entityId: EntityId };
                readonly to: { readonly entityId: EntityId };
                readonly amount: number;
                readonly fromAfter: number;
                readonly toAfter: number;
              };

              const from = moved.from.entityId as unknown as EntityPlanIdType;
              const to = moved.to.entityId as unknown as EntityPlanIdType;

              // A transfer is a spend on the source and a grant on the target:
              // the two scopes' own totals are what they were, and the shared
              // pool was not an endpoint.
              assert(
                ownOf(before, from) + ownOf(before, to) === ownOf(state, from) + ownOf(state, to),
                `transfer ${from} -> ${to} did not conserve units`,
              );
              assert(
                moved.fromAfter === ownOf(state, from) && moved.toAfter === ownOf(state, to),
                `transfer ${from} -> ${to} did not record its after-values`,
              );
              assert(
                moved.amount <= ownOf(before, from),
                `transfer ${from} -> ${to} moved more than the source owned`,
              );
              assert(
                poolOf(before) === poolOf(state),
                `transfer ${from} -> ${to} moved the shared pool`,
              );
            }

            if (event._tag === "UsageRecorded") {
              const usage = event as unknown as {
                readonly entity?: EntityId;
                readonly amount: number;
                readonly poolAfter?: number;
              };

              if (usage.entity === undefined || usage.poolAfter === undefined) continue;

              const id = usage.entity as unknown as EntityPlanIdType;
              const ownBefore = ownOf(before, id);
              const poolBefore = poolOf(before);
              const fromOwn = Math.min(usage.amount, Math.max(0, ownBefore));

              // A pooled item is drawn only after the scope's own sources: the
              // event leaves the scope at zero and lowers the one pool by the
              // part its own sources could not cover.
              assert(ownOf(state, id) === 0, `spend on ${id} reached the pool with own units left`);
              assert(
                usage.poolAfter === poolBefore - (usage.amount - fromOwn),
                `spend on ${id} did not lower the shared pool by the draw`,
              );
            }
          }
        }

        for (const id of entityIds) {
          if (entityOf(state, entityIdOf(id))?.status === "archived") {
            archivedHoldsNothing(state, id);
            noSpendAfterArchive(state, id);
          }
        }

        return true;
      },
      { runs: 80, size: 40 },
    ),
  );

  it("the fixture has a pooled item, an entity-owned plan and no seat occupied by accident", () => {
    const state = seeded();
    const a = entityOf(state, entityIdOf("ent-a"));

    assert(a !== undefined, "the fixture did not attach ent-a");
    assert(a.status === "attached", "the fixture archived ent-a");
    assert(ownOf(state, "ent-a") === 50, "the fixture's entity plan did not grant 50 messages");
    assert(poolOf(state) === 100, "the fixture's pooled item is not 100 messages");
  });
});

describe("the entity invariants, pinned", () => {
  it("draws the pooled source only after the scope's own units", () => {
    const state = seeded();

    const decision = decideAt(
      state,
      new TrackUsage({ feature: "messages", amount: 80, entity: entityIdOf("ent-a") }),
      start,
      "pooled-draw",
    );

    assert(isAccepted(decision), "the fixture refused the pooled spend");

    const usage = decision.find((event) => event._tag === "UsageRecorded") as
      | {
          readonly remainingAfter: number;
          readonly poolAfter?: number;
        }
      | undefined;

    assert(usage !== undefined, "the spend recorded no usage");
    assert(usage.remainingAfter === 0, "the spend kept own units while drawing the pool");
    assert(usage.poolAfter === 70, "the spend did not lower the pool by the uncovered part");

    const after = evolveAt(state, decision, start, "pooled-draw");

    assert(ownOf(after, "ent-a") === 0, "the scope kept the units it spent");
    assert(poolOf(after) === 70, "the customer's pool is not the one the scope drew");
  });

  it("moves a transfer's units without moving the pool", () => {
    const state = seeded();

    const decision = decideAt(
      state,
      new TransferBalance({
        from: { kind: "entity", entityId: entityIdOf("ent-a") },
        to: { kind: "entity", entityId: entityIdOf("ent-b") },
        feature: "messages",
        amount: 30,
      }),
      start,
      "transfer-pinned",
    );

    assert(isAccepted(decision), "the fixture refused the transfer");

    const moved = decision.find((event) => event._tag === "BalanceTransferred") as
      | {
          readonly amount: number;
          readonly plan: number;
          readonly grant: number;
          readonly fromAfter: number;
          readonly toAfter: number;
        }
      | undefined;

    assert(moved !== undefined, "the transfer recorded no event");
    assert(moved.plan === 30 && moved.grant === 0, "the transfer changed the class it moved");
    assert(moved.fromAfter === 20 && moved.toAfter === 80, "the transfer lost units");

    const after = evolveAt(state, decision, start, "transfer-pinned");

    assert(ownOf(after, "ent-a") === 20, "the source kept the units it moved");
    assert(ownOf(after, "ent-b") === 80, "the target did not receive the units");
    assert(poolOf(after) === 100, "the transfer moved the shared pool");
  });

  it("archives to an empty record and refuses every later scoped write", () => {
    let state = seeded();

    const granted = decideAt(
      state,
      new GrantBalance({
        feature: "messages",
        granted: 10,
        entity: entityIdOf("ent-a"),
      }),
      start,
      "grant-pinned",
    );

    assert(isAccepted(granted), "the fixture refused the grant");
    state = evolveAt(state, granted, start, "grant-pinned");
    assert(ownOf(state, "ent-a") === 60, "the grant did not land on the scope");

    const archived = decideAt(
      state,
      new ArchiveEntity({ entityId: entityIdOf("ent-a") }),
      start,
      "archive-pinned",
    );

    assert(isAccepted(archived), "the fixture refused the archive");
    state = evolveAt(state, archived, start, "archive-pinned");

    archivedHoldsNothing(state, "ent-a");
    noSpendAfterArchive(state, "ent-a");
    // The sweep returned the plan source and the grant to the one pool; nothing
    // was destroyed.
    assert(poolOf(state) === 160, "the archive did not return what the scope held");
  });
});
