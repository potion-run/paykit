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
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitModel, PaykitHandlers } from "../../src/Paykit.model.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import { canonical, commandOf, CommandPlan, start } from "./Arbitraries.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));

const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
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
