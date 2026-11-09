import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { planItemsOf, catalog } from "../../src/Catalog.ts";
import { EntityId } from "../../src/Customer.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitModel, PaykitHandlers } from "../../src/Paykit.model.ts";
import { ArchiveEntity } from "../../src/Subscription/ArchiveEntity.command.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { SetUsage } from "../../src/Subscription/SetUsage.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { TransferBalance } from "../../src/Subscription/TransferBalance.command.ts";
import { UpdateEntity } from "../../src/Subscription/UpdateEntity.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { Amount, canonical, commandOf, CommandPlan, DedupeKey, start } from "./Arbitraries.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const teamTier = tier({
  id: "team",
  grants: [allowance(messages, { included: 50 }), allowance(seats, { included: 2 })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages, seats], tiers: [freeTier, proTier, teamTier] }),
);

const free = planItemsOf(testCatalog, "free")!;
const pro = planItemsOf(testCatalog, "pro")!;
const team = planItemsOf(testCatalog, "team")!;
const price = { amount: 1900, currency: "usd", interval: "month" as const };

const World = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

describe("idempotence", () => {
  it.effect("a command replayed with the same commandId records no second event", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem");
      yield* subscription.send(
        account,
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "free",
          allowances: free,
        }),
        {
          commandId: "subscribe-1",
        },
      );

      const first = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" }),
        { commandId: "track-1" },
      );

      const second = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" }),
        { commandId: "track-1" },
      );

      expect(second.version).toBe(first.version);
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.usage.messages : -1).toBe(10);
    }).pipe(run),
  );

  it.effect("a payment failure replayed by webhook id does not advance dunning", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem_2");
      yield* subscription.send(
        account,
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "pro",
          allowances: pro,
          price,
        }),
        {
          commandId: "subscribe-2",
        },
      );
      const graceUntil = DateTime.makeUnsafe("2030-01-08T00:00:00Z");
      const command = new RecordPaymentFailure({ reason: "card_declined", graceUntil });
      yield* subscription.send(account, command, { commandId: "evt_failed_1" });
      yield* subscription.send(account, command, { commandId: "evt_failed_1" });
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.dunningAttempts : -1).toBe(1);
    }).pipe(run),
  );

  it.effect("the same usage key with a different commandId still records once", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem_3");
      yield* subscription.send(
        account,
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "free",
          allowances: free,
        }),
        {
          commandId: "subscribe-3",
        },
      );

      const first = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 7, dedupeKey: "req-7" }),
        { commandId: "track-7a" },
      );

      const second = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 7, dedupeKey: "req-7" }),
        { commandId: "track-7b" },
      );

      expect(second.version).toBe(first.version);
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.usage.messages : -1).toBe(7);
    }).pipe(run),
  );

  it.effect("a generated script replayed by command id records nothing new", () => {
    const IdempotenceScript = Schema.Struct({
      steps: Schema.Array(CommandPlan).pipe(Schema.check(Schema.isMaxLength(10))),
    });

    // Deterministic per script, so a replay token reaches the same account.
    const accountOf = (script: typeof IdempotenceScript.Type): string => {
      const input = JSON.stringify(script);
      let hash = 2_166_136_261;

      for (let index = 0; index < input.length; index++) {
        hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619);
      }

      return `acct_idem_gen_${(hash >>> 0).toString(36)}`;
    };

    return assertProperty(
      Arbitrary.schema(IdempotenceScript),
      (script) =>
        Effect.gen(function* () {
          const subscription = yield* Subscription;
          const account = Subscription.ref(accountOf(script));

          const accepted: Array<{
            readonly commandId: string;
            readonly command: { readonly _tag: string };
            readonly version: number;
          }> = [];

          for (const [index, plan] of script.steps.entries()) {
            const state = yield* subscription.state(account);
            const command = commandOf(plan, state, start);
            const commandId = `idem-${index}`;

            const result = yield* Effect.result(
              subscription.send(account, command as never, { commandId }),
            );

            if (Result.isFailure(result)) continue;
            accepted.push({ commandId, command, version: result.success.version });
          }

          // Every accepted command replayed with its own id is a receipt, not
          // a second event. The store dedupes before it decides, so the
          // snapshot and the version must not move.
          for (const entry of accepted) {
            const before = yield* subscription.state(account);

            const again = yield* subscription.send(account, entry.command as never, {
              commandId: entry.commandId,
            });

            if (again.version !== entry.version) return false;
            const after = yield* subscription.state(account);

            if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) {
              return false;
            }
          }

          return true;
        }).pipe(run),
      { runs: 20, size: 20 },
    );
  });
});

const EntityLabel = Schema.optionalKey(Schema.Literals(["team-a", "team-b"]));

/** The ids the entity idempotence scripts may name; `ent-c` starts detached. */
const EntityCommandId = Schema.Literals(["ent-a", "ent-b", "ent-c"]);

type EntityCommandId = typeof EntityCommandId.Type;

/**
 * The entity-scoped commands whose receipt is the command id. A scoped write
 * and a lifecycle move share one writer — the customer's aggregate — so a
 * replay has to leave every scope exactly where the first send left it.
 */
const EntityCommand = Schema.Union([
  Schema.TaggedStruct("AttachEntity", { entityId: EntityCommandId, name: EntityLabel }),
  Schema.TaggedStruct("UpdateEntity", { entityId: EntityCommandId, name: EntityLabel }),
  Schema.TaggedStruct("ArchiveEntity", { entityId: EntityCommandId }),
  Schema.TaggedStruct("TransferBalance", {
    from: EntityCommandId,
    to: EntityCommandId,
    amount: Amount,
  }),
  Schema.TaggedStruct("TrackUsage", {
    entityId: EntityCommandId,
    amount: Amount,
    dedupeKey: DedupeKey,
  }),
  Schema.TaggedStruct("SetUsage", {
    entityId: EntityCommandId,
    usage: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
  }),
  Schema.TaggedStruct("GrantBalance", { entityId: EntityCommandId, amount: Amount }),
]);

type EntityCommand = typeof EntityCommand.Type;

const entityIdOf = (id: EntityCommandId): EntityId => EntityId.make(id);

/** Build the real command for a plan, against the state it will decide. */
const entityCommandOf = (plan: EntityCommand): { readonly _tag: string } => {
  switch (plan._tag) {
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
    case "TransferBalance":
      return new TransferBalance({
        from: { kind: "entity", entityId: entityIdOf(plan.from) },
        to: { kind: "entity", entityId: entityIdOf(plan.to) },
        feature: "messages",
        amount: plan.amount,
      });
    case "TrackUsage":
      return new TrackUsage({
        feature: "messages",
        amount: plan.amount,
        entity: entityIdOf(plan.entityId),
        ...(plan.dedupeKey === undefined ? {} : { dedupeKey: plan.dedupeKey }),
      });
    case "SetUsage":
      return new SetUsage({
        feature: "seats",
        usage: plan.usage,
        entity: entityIdOf(plan.entityId),
      });
    case "GrantBalance":
      return new GrantBalance({
        feature: "messages",
        granted: plan.amount,
        entity: entityIdOf(plan.entityId),
      });
  }
};

/** A customer with two entities, each holding a team plan. */
const entityWorld = Effect.gen(function* () {
  const subscription = yield* Subscription;
  const account = Subscription.ref("acct_idem_entities");

  yield* subscription.send(
    account,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "free",
      allowances: free,
    }),
    { commandId: "entity-seed-subscribe" },
  );

  for (const id of ["ent-a", "ent-b"] as const) {
    yield* subscription.send(account, new AttachEntity({ entityId: entityIdOf(id) }), {
      commandId: `entity-seed-attach-${id}`,
    });
    yield* subscription.send(
      account,
      new ChangeTier({
        tier: "team",
        allowances: team,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        entity: entityIdOf(id),
      }),
      { commandId: `entity-seed-plan-${id}` },
    );
  }

  return account;
});

describe("idempotence across entity scopes", () => {
  it.effect("a scoped command replayed with its id records once and leaves every scope alone", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = yield* entityWorld;

      const replayOnce = (plan: EntityCommand, commandId: string) =>
        Effect.gen(function* () {
          const command = entityCommandOf(plan);
          const before = yield* subscription.state(account);
          const first = yield* subscription.send(account, command as never, { commandId });
          const recorded = yield* subscription.state(account);
          const again = yield* subscription.send(account, command as never, { commandId });
          const after = yield* subscription.state(account);

          // The first send is a real write; the replay is the same receipt.
          expect(JSON.stringify(canonical(recorded))).not.toBe(JSON.stringify(canonical(before)));
          expect(again.version).toBe(first.version);
          expect(JSON.stringify(canonical(after))).toBe(JSON.stringify(canonical(recorded)));

          for (const [id, record] of Object.entries(recorded.entities ?? {})) {
            expect(JSON.stringify(after.entities?.[id])).toBe(JSON.stringify(record));
          }
        });

      yield* replayOnce(
        { _tag: "AttachEntity", entityId: "ent-c", name: "team-a" },
        "entity-attach",
      );
      yield* replayOnce(
        { _tag: "UpdateEntity", entityId: "ent-a", name: "team-b" },
        "entity-update",
      );
      yield* replayOnce(
        { _tag: "TrackUsage", entityId: "ent-a", amount: 10, dedupeKey: "req-a" },
        "entity-track",
      );
      yield* replayOnce({ _tag: "SetUsage", entityId: "ent-a", usage: 1 }, "entity-usage");
      yield* replayOnce(
        { _tag: "TransferBalance", from: "ent-a", to: "ent-b", amount: 5 },
        "entity-transfer",
      );
      yield* replayOnce({ _tag: "GrantBalance", entityId: "ent-b", amount: 10 }, "entity-grant");
      yield* replayOnce({ _tag: "ArchiveEntity", entityId: "ent-c" }, "entity-archive");
    }).pipe(run),
  );

  it.effect("a generated entity history replays by command id without moving any scope", () => {
    const EntityScript = Schema.Struct({
      steps: Schema.Array(EntityCommand).pipe(Schema.check(Schema.isMaxLength(8))),
    });

    const accountOf = (script: typeof EntityScript.Type): string => {
      const input = JSON.stringify(script);
      let hash = 2_166_136_261;

      for (let index = 0; index < input.length; index++) {
        hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619);
      }

      return `acct_idem_entity_gen_${(hash >>> 0).toString(36)}`;
    };

    return assertProperty(
      Arbitrary.schema(EntityScript),
      (script) =>
        Effect.gen(function* () {
          const subscription = yield* Subscription;
          const account = Subscription.ref(accountOf(script));

          yield* subscription.send(
            account,
            new Subscribe({
              credits: 0,
              creditsExpire: "period",
              rates: {},
              tier: "free",
              allowances: free,
            }),
            { commandId: "generated-seed-subscribe" },
          );

          for (const id of ["ent-a", "ent-b"] as const) {
            yield* subscription.send(account, new AttachEntity({ entityId: entityIdOf(id) }), {
              commandId: `generated-seed-attach-${id}`,
            });
            yield* subscription.send(
              account,
              new ChangeTier({
                tier: "team",
                allowances: team,
                credits: 0,
                creditsExpire: "period",
                rates: {},
                entity: entityIdOf(id),
              }),
              { commandId: `generated-seed-plan-${id}` },
            );
          }

          const accepted: Array<{
            readonly commandId: string;
            readonly command: { readonly _tag: string };
            readonly version: number;
          }> = [];

          for (const [index, plan] of script.steps.entries()) {
            const command = entityCommandOf(plan);
            const commandId = `entity-idem-${index}`;

            const result = yield* Effect.result(
              subscription.send(account, command as never, { commandId }),
            );

            if (Result.isFailure(result)) continue;
            accepted.push({ commandId, command, version: result.success.version });
          }

          for (const entry of accepted) {
            const before = yield* subscription.state(account);

            const again = yield* subscription.send(account, entry.command as never, {
              commandId: entry.commandId,
            });

            const after = yield* subscription.state(account);

            if (again.version !== entry.version) return false;

            if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) {
              return false;
            }

            for (const [id, record] of Object.entries(before.entities ?? {})) {
              if (JSON.stringify(record) !== JSON.stringify(after.entities?.[id])) return false;
            }
          }

          return true;
        }).pipe(run),
      { runs: 20, size: 12 },
    );
  });
});
