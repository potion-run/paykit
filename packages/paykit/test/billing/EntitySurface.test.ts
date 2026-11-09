import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach, PreviewAttach } from "../../src/Billing/Attach.binding.ts";
import { Balances } from "../../src/Billing/Balances.binding.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingCommandsLive } from "../../src/Billing/Commands.rpc.ts";
import { Customers } from "../../src/Billing/Customers.binding.ts";
import { Entities } from "../../src/Billing/Entities.binding.ts";
import { GrantBalance } from "../../src/Billing/GrantBalance.binding.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { TransferBalance } from "../../src/Billing/TransferBalance.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { EntityId } from "../../src/Customer.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [
      tier({ id: "free", grants: [allowance(messages, { included: 100 })] }),
      tier({
        id: "team",
        price: { amount: 500, currency: "usd", interval: "month" },
        grants: [allowance(messages, { included: 50 })],
      }),
    ],
  }),
);

const account = "acct_entity_surface" as AccountId;

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

const inProcessWorld = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(Layer.provideMerge(Model));

const apiWorld = Layer.mergeAll(
  BillingApiLayer.pipe(Layer.provideMerge(BillingCommandsLive)),
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": account } })),
);

type World = Layer.Success<typeof apiWorld>;

const both = <A, E>(name: string, body: () => Effect.Effect<A, E, World>) => {
  const run = () => body();
  it.live(`${name} over the model`, () => run().pipe(Effect.provide(inProcessWorld)));
  it.live(`${name} over the Api`, () => run().pipe(Effect.provide(apiWorld)));
};

const subscribe = Effect.gen(function* () {
  const subscribe = yield* subscribeOperation();
  yield* subscribe({ account, tier: "free" });
});

const entA = EntityId.make("ent_a");
const entB = EntityId.make("ent_b");

const createEntity = (entityId: EntityId, name: string) =>
  Effect.gen(function* () {
    const entities = yield* Entities(account);

    return yield* entities.create({ entityId, name });
  });

describe("the entity surface", () => {
  both("creates, lists, renames and archives a scope, and the customer carries the list", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const entities = yield* Entities(account);
      const customers = yield* Customers(account);

      const created = yield* entities.create({ entityId: entA, name: "Support" });

      expect(created.id).toBe(entA);
      expect(created.parentId).toBe(account);
      expect(created.status).toBe("attached");
      expect((yield* entities.list()).map((entity) => entity.id)).toEqual([entA]);
      expect((yield* entities.get(entA)).name).toBe("Support");

      const renamed = yield* entities.update({
        entityId: entA,
        name: "Support EU",
        idempotencyKey: "rename-support-1",
      });

      expect(renamed.name).toBe("Support EU");
      expect((yield* customers.get()).entities.map((entity) => entity.name)).toEqual([
        "Support EU",
      ]);

      const archived = yield* entities.archive({
        entityId: entA,
        idempotencyKey: "archive-support-1",
      });

      expect(archived.status).toBe("archived");
      expect(archived.archivedAt).toBeDefined();
      expect((yield* entities.list()).map((entity) => entity.status)).toEqual(["archived"]);
    }),
  );

  it.live("attaches a plan to an entity's own scope", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");

      const attached = yield* (yield* Attach(account))({
        entityId: entA,
        planId: "team",
        planSchedule: "immediate",
        idempotencyKey: "attach-entity-team",
      });

      expect(attached.outcome).toBe("changed");
      expect(attached.planId).toBe("team");

      const balances = yield* Balances(account);
      const own = yield* balances.get({ entityId: entA, featureId: "messages" });
      const customer = yield* balances.get({ featureId: "messages" });

      expect(own.scope).toEqual({ kind: "entity", entityId: entA });
      expect(own.remaining).toBe(50);
      // The customer's plan did not move.
      expect(customer.scope).toEqual({ kind: "customer" });
      expect(customer.remaining).toBe(100);
    }).pipe(Effect.provide(inProcessWorld)),
  );

  both("creates a scope before the customer has a standing", () =>
    Effect.gen(function* () {
      const entities = yield* Entities(account);

      const created = yield* entities.create({ entityId: entA, name: "Early" });

      expect(created.status).toBe("attached");
      expect((yield* entities.get(entA)).name).toBe("Early");
    }),
  );

  it.live("previews a plan move on an entity's scope", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");

      const preview = yield* PreviewAttach(account);

      const answer = yield* preview({
        entityId: entA,
        planId: "team",
        planSchedule: "immediate",
      });

      expect(answer.outcome).toBe("changed");
      expect(answer.preview?._tag).toBe("accepted");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  both("reads, grants and spends a scoped balance", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");

      const balances = yield* Balances(account);

      const grant = yield* (yield* GrantBalance(account))({
        featureId: "messages",
        entityId: entA,
        granted: 30,
        idempotencyKey: "grant-entity-1",
      });

      expect(grant.balance.scope).toEqual({ kind: "entity", entityId: entA });
      expect(grant.balance.remaining).toBe(30);

      const own = yield* balances.get({ entityId: entA, featureId: "messages" });

      expect(own.scope).toEqual({ kind: "entity", entityId: entA });
      expect(own.remaining).toBe(30);
      expect((yield* balances.list({ entityId: entA })).map((row) => row.featureId)).toEqual([
        "messages",
      ]);

      const tracked = yield* (yield* TrackUsage(account))({
        featureId: "messages",
        entityId: entA,
        value: 10,
        idempotencyKey: "usage-entity-1",
      });

      expect(tracked.balance.scope).toEqual({ kind: "entity", entityId: entA });
      expect(tracked.balance.remaining).toBe(20);

      const answer = yield* (yield* Check(account))({
        featureId: "messages",
        entityId: entA,
        requiredBalance: 1,
      });

      expect(answer.allowed).toBe(true);
      expect(answer.balance.scope).toEqual({ kind: "entity", entityId: entA });
      expect(answer.balance.remaining).toBe(20);
    }),
  );

  both("moves units between two scopes and reports both after-values", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");
      yield* createEntity(entB, "B");

      const grant = yield* GrantBalance(account);
      yield* grant({
        featureId: "messages",
        entityId: entA,
        granted: 30,
        idempotencyKey: "grant-a",
      });
      yield* grant({
        featureId: "messages",
        entityId: entB,
        granted: 5,
        idempotencyKey: "grant-b",
      });

      const transfer = yield* TransferBalance(account);

      const moved = yield* transfer({
        from: { kind: "entity", entityId: entA },
        to: { kind: "entity", entityId: entB },
        featureId: "messages",
        amount: 10,
        idempotencyKey: "transfer-1",
      });

      expect(moved.amount).toBe(10);
      expect(moved.from.scope).toEqual({ kind: "entity", entityId: entA });
      expect(moved.from.remaining).toBe(20);
      expect(moved.to.scope).toEqual({ kind: "entity", entityId: entB });
      expect(moved.to.remaining).toBe(15);
    }),
  );

  both("refuses a write on an archived scope", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");

      const entities = yield* Entities(account);

      yield* entities.archive({ entityId: entA, idempotencyKey: "archive-a" });

      const refused = yield* Effect.flip(
        (yield* TrackUsage(account))({
          featureId: "messages",
          entityId: entA,
          value: 1,
          idempotencyKey: "usage-archived",
        }),
      );

      expect((refused as { _tag: string })._tag).toBe("EntityArchived");
    }),
  );

  both("refuses an archived scope's grant too", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* createEntity(entA, "A");

      yield* (yield* Entities(account)).archive({
        entityId: entA,
        idempotencyKey: "archive-a",
      });

      const refused = yield* Effect.flip(
        (yield* GrantBalance(account))({
          featureId: "messages",
          entityId: entA,
          granted: 1,
          idempotencyKey: "grant-archived",
        }),
      );

      expect((refused as { _tag: string })._tag).toBe("EntityArchived");
    }),
  );
});
