import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { balanceOfEntity } from "../../src/Balance.ts";
import { EntityId } from "../../src/Customer.ts";
import { messages } from "../../src/Feature.ts";
import { ArchiveEntity } from "../../src/Subscription/ArchiveEntity.command.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  remainingOf,
  scopeStateOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TransferBalance } from "../../src/Subscription/TransferBalance.command.ts";
import { planRow, planSet } from "../support/Plans.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const account = "acct_transfer";
const id = Subscription.ref(account).id;
const context = Context.make(Actor, system("test"));

const entA = EntityId.make("ent_a");
const entB = EntityId.make("ent_b");
const customer = { kind: "customer" } as const;
const a = { kind: "entity", entityId: entA } as const;
const b = { kind: "entity", entityId: entB } as const;

const subscribed = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
  ({
    _tag: "Subscribed",
    plans: planSet(
      planRow("pro", { allowances: { messages: allowance(messages, { included: 100 }) } }),
    ),
    schedule: [],
    status: "active",
    period: { start, end: monthLater, anchorTz: "UTC" },
    cancelAtPeriodEnd: false,
    credits: 0,
    usage: {},
    remaining: { messages: 100 },
    holds: {},
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
    entities: {},
    ...overrides,
  }) as never;

const run = (state: SubscribedState, command: object, now = start) =>
  Subscription.predict(state, command as never, {
    id,
    now,
    context,
    commandId: "transfer-1",
  });

const after = (state: SubscribedState, command: object): SubscribedState => {
  const result = run(state, command);

  if (result._tag !== "Accepted") throw new Error(`refused: ${String(result._tag)}`);

  return result.state as SubscribedState;
};

const attach = (state: SubscribedState, entityId: EntityId) =>
  after(state, new AttachEntity({ entityId }));

const planFor = (state: SubscribedState, entityId: EntityId, included: number) =>
  after(
    state,
    new ChangeTier({
      tier: "team",
      allowances: { messages: allowance(messages, { included }) },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      entity: entityId,
    }),
  );

/** Two entities, one with 100 units of its own and one with 40. */
const twoScopes = (): SubscribedState =>
  planFor(planFor(attach(attach(subscribed(), entA), entB), entA, 100), entB, 40);

const transfer = (
  from: typeof customer | typeof a | typeof b,
  to: typeof a | typeof b,
  amount: number,
) => new TransferBalance({ from, to, feature: "messages", amount });

const own = (state: SubscribedState, entityId: EntityId) =>
  remainingOf(scopeStateOf(state, entityId), "messages") ?? 0;

describe("one transfer, one event", () => {
  it("conserves the total across the two scopes and records both after-values", () => {
    const state = twoScopes();
    const before = own(state, entA) + own(state, entB);

    const result = run(state, transfer(a, b, 60));

    expect(result._tag).toBe("Accepted");

    if (result._tag !== "Accepted") return;

    const event = result.events[0] as unknown as {
      _tag: string;
      amount: number;
      plan: number;
      grant: number;
      fromAfter: number;
      toAfter: number;
    };

    expect(result.events).toHaveLength(1);
    expect(event._tag).toBe("BalanceTransferred");
    expect(event.amount).toBe(60);
    expect(event.plan + event.grant).toBe(60);
    expect(event.fromAfter).toBe(40);
    expect(event.toAfter).toBe(100);

    const moved = result.state as SubscribedState;

    expect(own(moved, entA) + own(moved, entB)).toBe(before);
    expect(own(moved, entA)).toBe(40);
    expect(own(moved, entB)).toBe(100);
  });

  it("carries a lifetime grant across as a grant, with its class and deadline", () => {
    const granted = after(
      twoScopes(),
      new GrantBalance({
        feature: "messages",
        granted: 30,
        expiresAt: monthLater,
        entity: entA,
      }),
    );

    // 100 plan units and 30 grant units: a transfer of 120 takes all 100 plan
    // units and 20 of the grant.
    const result = run(granted, transfer(a, b, 120));

    if (result._tag !== "Accepted") throw new Error("refused");

    const event = result.events[0] as unknown as {
      plan: number;
      grant: number;
      expiresAt?: DateTime.Utc;
    };

    expect(event.plan).toBe(100);
    expect(event.grant).toBe(20);
    expect(event.expiresAt?.epochMilliseconds).toBe(monthLater.epochMilliseconds);

    const moved = result.state as SubscribedState;

    const arrived = balanceOfEntity(
      {
        account,
        tier: "team",
        status: "active",
        standing: "good",
        periodStart: start,
        periodEnd: monthLater,
        cancelAtPeriodEnd: false,
        credits: 0,
        dunningAttempts: 0,
        features: {},
        entities: {
          ent_b: {
            id: entB,
            status: "attached",
            createdAt: start,
            features: {},
          },
        },
      },
      "ent_b",
      "messages",
    );

    // The target keeps a lifetime grant record, not a second plan source.
    expect(Object.values(moved.entities?.ent_b?.grants ?? {})).toHaveLength(1);
    void arrived;
  });
});

describe("what a transfer may not do", () => {
  it("refuses more than the source owns, with the ceiling it had", () => {
    const refusal = run(twoScopes(), transfer(a, b, 101));

    expect(refusal._tag).toBe("Rejected");
    expect((refusal as { rejection: { _tag: string; available: number } }).rejection._tag).toBe(
      "TransferExceedsBalance",
    );
    expect((refusal as { rejection: { available: number } }).rejection.available).toBe(100);
  });

  it("refuses an unknown scope and an archived one", () => {
    const state = twoScopes();

    expect(
      (
        run(state, transfer(customer, { kind: "entity", entityId: EntityId.make("ent_x") }, 1)) as {
          rejection: { _tag: string };
        }
      ).rejection._tag,
    ).toBe("EntityUnknown");

    const archived = after(state, new ArchiveEntity({ entityId: entB }));

    expect(
      (run(archived, transfer(a, b, 1)) as { rejection: { _tag: string } }).rejection._tag,
    ).toBe("EntityArchived");
  });

  it("refuses a credit system's units, which are one pool per customer", () => {
    const state = attach(
      subscribed({
        plans: planSet(
          planRow("pro", {
            allowances: {},
            rates: { messages: { default: 2 } },
          }),
        ),
        remaining: {},
      }),
      entA,
    );

    expect(
      (run(state, transfer(customer, a, 1)) as { rejection: { _tag: string } }).rejection._tag,
    ).toBe("TransferOfCreditSystem");
  });

  it("refuses to move the shared pool, into or out of the customer", () => {
    const state = attach(
      subscribed({
        plans: planSet(
          planRow("pool", {
            addOn: true,
            allowances: { messages: allowance(messages, { included: 100, pooled: true }) },
          }),
        ),
      }),
      entA,
    );

    expect(
      (run(state, transfer(customer, a, 1)) as { rejection: { _tag: string } }).rejection._tag,
    ).toBe("TransferOfPooledSource");
  });

  it("moves no occupancy: the source's purchase is what it was", () => {
    const state = twoScopes();
    const moved = after(state, transfer(a, b, 10));

    expect(moved.entities?.ent_a?.quantities).toEqual(state.entities?.ent_a?.quantities);
    expect(moved.entities?.ent_a?.occupied).toEqual(state.entities?.ent_a?.occupied);
  });
});
