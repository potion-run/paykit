import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { balanceOfEntity } from "../../src/Balance.ts";
import { EntityId } from "../../src/Customer.ts";
import { feature, messages } from "../../src/Feature.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

import { ArchiveEntity } from "../../src/Subscription/ArchiveEntity.command.ts";
import { AttachEntity } from "../../src/Subscription/AttachEntity.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements, initialEntitlements } from "../../src/Subscription/Entitlements.view.ts";
import { GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { SetUsage } from "../../src/Subscription/SetUsage.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  allowancesOf,
  entityOf,
  remainingOf,
  scopeStateOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { UpdateEntity } from "../../src/Subscription/UpdateEntity.command.ts";
import { planRow, planSet } from "../support/Plans.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const account = "acct_entities";
const id = Subscription.ref(account).id;
const context = Context.make(Actor, system("test"));

const entA = EntityId.make("ent_a");
const entB = EntityId.make("ent_b");

/** The customer: one plan of its own and one pooled item both entities draw on. */
const subscribed = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
  ({
    _tag: "Subscribed",
    plans: planSet(
      // The customer's own plan grants nothing of `messages`: the pool is the
      // one source of it, so the fixture cannot merge a private grant into it.
      planRow("pro", { allowances: {} }),
      planRow("pool", {
        addOn: true,
        allowances: { messages: allowance(messages, { included: 1_000, pooled: true }) },
      }),
    ),
    schedule: [],
    status: "active",
    period: { start, end: monthLater, anchorTz: "UTC" },
    cancelAtPeriodEnd: false,
    credits: 0,
    usage: {},
    // The customer's own count is the shared pool: a pooled item is one source.
    remaining: { messages: 1_000 },
    holds: {},
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
    entities: {},
    ...overrides,
  }) as never;

type Outcome = SubscribedState | { readonly _tag: string };

interface Predicted {
  readonly _tag: "Accepted";
  readonly events: ReadonlyArray<{ readonly _tag: string }>;
  readonly state: SubscribedState;
}

const predict = (state: SubscribedState, command: object, now = start) =>
  Subscription.predict(state, command as never, { id, now, context }) as
    | Predicted
    | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
    | { readonly _tag: "Unpredictable" };

const run = (state: SubscribedState, command: object, now = start): Outcome => {
  const result = predict(state, command, now);

  if (result._tag === "Accepted") return result.state;

  if (result._tag === "Rejected") return result.rejection;

  return { _tag: "Unpredictable" };
};

const accepted = (state: SubscribedState, command: object, now = start): SubscribedState => {
  const result = run(state, command, now);

  if (!("entities" in result) && !("plans" in result)) throw new Error(`refused: ${result._tag}`);

  return result;
};

const attach = (state: SubscribedState, entityId: EntityId, name?: string) =>
  accepted(
    state,
    new AttachEntity({
      entityId,
      ...(name === undefined ? {} : { name }),
    }),
  );

const twoEntities = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
  attach(attach(subscribed(overrides), entA, "A"), entB, "B");

/** A scenario whose two entities were attached through the log, for a view. */
const entityScenario = () => {
  const traced = scenario();

  // Record the customer's pooled item through the log, so the view's own rows
  // carry `pooled` exactly as a deploy's would (ADR 0040 §3-4).
  traced.step(
    new ChangeTier({
      tier: "pool",
      addOn: true,
      allowances: { messages: allowance(messages, { included: 1_000, pooled: true }) },
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  );
  traced.step(new AttachEntity({ entityId: entA, name: "A" }));
  traced.step(new AttachEntity({ entityId: entB, name: "B" }));

  return traced;
};

/** Attach a plan to one entity's scope, with the catalog terms a command carries. */
const attachPlan = (state: SubscribedState, entityId: EntityId, planId: string, included: number) =>
  accepted(
    state,
    new ChangeTier({
      tier: planId,
      allowances: { messages: allowance(messages, { included }) },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      entity: entityId,
    }),
  );

const track = (state: SubscribedState, entityId: EntityId, amount: number, now = start) =>
  run(
    state,
    new TrackUsage({
      feature: "messages",
      amount,
      entity: entityId,
      dedupeKey: `${entityId}:${String(amount)}:${String(now.epochMilliseconds)}`,
    }),
    now,
  );

const eventsOf = (state: SubscribedState, command: object, now = start) => {
  const result = predict(state, command, now);

  return result._tag === "Accepted" ? result.events : [];
};

const evolve = Entitlements.definition.evolve as Readonly<
  Record<
    string,
    (
      state: typeof initialEntitlements,
      event: unknown,
      context: unknown,
    ) => typeof initialEntitlements
  >
>;

const view = (events: ReadonlyArray<{ _tag: string }>) =>
  events.reduce(
    (state, event) =>
      evolve[event._tag]?.(state, event, { key: Subscription.ref(account) }) ?? state,
    initialEntitlements,
  );

/**
 * A command sequence and the events it recorded, so a test can read the folded
 * view without a platform: `predict` decides and evolves the aggregate, and the
 * events it returns are what the views fold.
 */
const scenario = (initial: SubscribedState = subscribed()) => ({
  state: initial,
  events: [] as Array<{ readonly _tag: string }>,
  step(command: object, now = start) {
    const result = predict(this.state, command, now);

    if (result._tag === "Accepted") {
      this.state = result.state;
      this.events.push(...result.events);
    }

    return result;
  },
  view() {
    return view(this.events);
  },
});

describe("two entities, two plan sets", () => {
  it("writes the scope the command names and leaves the sibling and customer alone", () => {
    const state = twoEntities();
    const changed = attachPlan(state, entA, "team", 50);

    expect(entityOf(changed, entA)?.plans.team?.planId).toBe("team");
    expect(remainingOf(scopeStateOf(changed, entA), "messages")).toBe(50);
    // The sibling and the customer keep what they had.
    expect(allowancesOf(scopeStateOf(changed, entB)).messages).toBeUndefined();
    expect(remainingOf(scopeStateOf(changed), "messages")).toBe(1_000);
    expect(Object.keys(changed.plans).sort()).toEqual(["pool", "pro"]);
  });

  it("refuses a pooled item on an entity, because that would be a second pool", () => {
    const refusal = run(
      twoEntities(),
      new ChangeTier({
        tier: "pool",
        allowances: { messages: allowance(messages, { included: 500, pooled: true }) },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        entity: entA,
      }),
    );

    expect((refusal as { _tag: string })._tag).toBe("PooledItemOnEntity");
  });
});

describe("a pooled grant is one source", () => {
  it("is drawn only after the entity's own sources are empty, and the sibling sees it", () => {
    const traced = entityScenario();

    traced.step(
      new ChangeTier({
        tier: "team",
        allowances: { messages: allowance(messages, { included: 50 }) },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        entity: entA,
      }),
    );

    const result = traced.step(new TrackUsage({ feature: "messages", amount: 180, entity: entA }));

    const event = (result as { events: ReadonlyArray<unknown> }).events[0] as
      | { _tag: string; remainingAfter: number; poolAfter?: number }
      | undefined;

    // The event carries the split: 50 from the entity's own plan, 130 from the
    // one shared source, whose remaining every attached entity reports.
    expect(event?._tag).toBe("UsageRecorded");
    expect(event?.remainingAfter).toBe(0);
    expect(event?.poolAfter).toBe(870);
    expect(remainingOf(scopeStateOf(traced.state, entA), "messages")).toBe(0);

    console.log(
      "DBG features",
      JSON.stringify(traced.view().features),
      "events",
      traced.events.map((e) => e._tag).join(","),
    );
    const sibling = balanceOfEntity(traced.view(), "ent_b", "messages");

    expect(sibling?.breakdown.filter((row) => row.pooled === true)).toHaveLength(1);
    expect(sibling?.breakdown.find((row) => row.pooled === true)?.remaining).toBe(870);
  });

  it("reports the pool once on the customer and once per entity, with the same source id", () => {
    const traced = entityScenario();
    traced.step(new TrackUsage({ feature: "messages", amount: 10, entity: entA }));

    const entity = balanceOfEntity(traced.view(), "ent_a", "messages");
    const pooled = entity?.breakdown.find((row) => row.pooled === true);

    expect(pooled?.id).toBe("pool:messages");
    expect(pooled?.scope).toEqual({ kind: "customer" });
    // The entity's total is its own row plus the shared row, not a share.
    expect(entity?.remaining).toBe(990);
  });
});

describe("the entity lifecycle", () => {
  it("refuses an unknown id, a second attach and a write after the archive", () => {
    expect(
      (
        run(twoEntities(), new UpdateEntity({ entityId: EntityId.make("ent_x") })) as {
          _tag: string;
        }
      )._tag,
    ).toBe("EntityUnknown");
    expect(
      (run(twoEntities(), new AttachEntity({ entityId: entA })) as { _tag: string })._tag,
    ).toBe("EntityExists");

    const archived = accepted(twoEntities(), new ArchiveEntity({ entityId: entB }));

    expect((track(archived, entB, 1) as { _tag: string })._tag).toBe("EntityArchived");
    expect((run(archived, new ArchiveEntity({ entityId: entB })) as { _tag: string })._tag).toBe(
      "EntityArchived",
    );
    expect(
      (
        run(archived, new GrantBalance({ feature: "messages", granted: 1, entity: entB })) as {
          _tag: string;
        }
      )._tag,
    ).toBe("EntityArchived");
  });

  it("renames without moving a balance and records nothing for an equal name", () => {
    const state = attach(subscribed(), entA, "A");
    const renamed = accepted(state, new UpdateEntity({ entityId: entA, name: "Support EU" }));

    expect(entityOf(renamed, entA)?.name).toBe("Support EU");
    expect(
      eventsOf(renamed, new UpdateEntity({ entityId: entA, name: "Support EU" })),
    ).toHaveLength(0);
  });

  it("refuses an archive while a seat is occupied, and allows it once zeroed", () => {
    const state = twoEntities();

    const seated = accepted(
      state,
      new ChangeTier({
        tier: "team",
        allowances: { seats: allowance(seats, { included: 2 }) },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        entity: entA,
      }),
    );

    const inUse = accepted(seated, new SetUsage({ feature: "seats", usage: 1, entity: entA }));

    expect((run(inUse, new ArchiveEntity({ entityId: entA })) as { _tag: string })._tag).toBe(
      "EntityHasOccupancy",
    );

    const zeroed = accepted(inUse, new SetUsage({ feature: "seats", usage: 0, entity: entA }));

    expect((run(zeroed, new ArchiveEntity({ entityId: entA })) as { _tag: string })._tag).not.toBe(
      "EntityHasOccupancy",
    );
  });

  it("returns the entity's own sources to the customer and holds nothing afterwards", () => {
    const state = attachPlan(twoEntities(), entA, "team", 50);

    const granted = accepted(
      state,
      new GrantBalance({ feature: "messages", granted: 25, entity: entA }),
    );

    const before = remainingOf(scopeStateOf(granted), "messages") ?? 0;

    const events = eventsOf(granted, new ArchiveEntity({ entityId: entA }));

    const archive = events.find((event) => event._tag === "EntityArchived") as
      | { returned: ReadonlyArray<{ feature: string; kind: string; amount: number }> }
      | undefined;

    expect(archive?.returned).toContainEqual({
      feature: "messages",
      kind: "plan",
      amount: 50,
      interval: "month",
    });
    expect(archive?.returned).toContainEqual(
      expect.objectContaining({ feature: "messages", kind: "grant", amount: 25 }),
    );

    const archived = accepted(granted, new ArchiveEntity({ entityId: entA }));
    const record = entityOf(archived, entA);

    expect(record?.status).toBe("archived");
    expect(record?.remaining).toEqual({});
    expect(record?.plans).toEqual({});
    // The customer received exactly what the scope held; nothing was destroyed.
    expect(remainingOf(scopeStateOf(archived), "messages")).toBe(before + 75);
  });
});

describe("the close", () => {
  it("resets each entity's plan and leaves its lifetime grant alone", () => {
    const state = attachPlan(twoEntities(), entA, "team", 50);

    const granted = accepted(
      state,
      new GrantBalance({ feature: "messages", granted: 40, entity: entA }),
    );

    const closed = accepted(granted, new ClosePeriod({ periodEnd: monthLater }), monthLater);

    // The plan source restarted at 50; the lifetime grant is still 40.
    expect(remainingOf(scopeStateOf(closed, entA), "messages")).toBe(90);
    expect(Object.values(entityOf(closed, entA)?.grants ?? {})).toHaveLength(1);
    expect(Object.keys(allowancesOf(scopeStateOf(closed, entA)))).toEqual(["messages"]);
  });
});

describe("a read for one scope", () => {
  it("answers the entity's own rows with the pooled row appended", () => {
    const traced = entityScenario();

    traced.step(
      new ChangeTier({
        tier: "team",
        allowances: { messages: allowance(messages, { included: 50 }) },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        entity: entA,
      }),
    );
    traced.step(new TrackUsage({ feature: "messages", amount: 10, entity: entA }));

    const balance = balanceOfEntity(traced.view(), "ent_a", "messages");

    expect(balance?.scope).toEqual({ kind: "entity", entityId: "ent_a" });
    expect(balance?.breakdown.map((row) => row.kind)).toEqual(["plan", "plan"]);
    expect(balance?.breakdown[0]?.scope).toEqual({ kind: "entity", entityId: "ent_a" });
    expect(balance?.breakdown[0]?.remaining).toBe(40);
    expect(balance?.breakdown[1]?.id).toBe("pool:messages");
  });

  it("answers an archived entity with an empty balance, not the sibling's", () => {
    const traced = entityScenario();
    traced.step(new ArchiveEntity({ entityId: entA }));
    traced.step(new ClosePeriod({ periodEnd: monthLater }), monthLater);

    expect(balanceOfEntity(traced.view(), "ent_a", "messages")?.breakdown).toEqual([]);
    // The close re-grants the customer's pooled source; the sibling still sees
    // the one row, and the archived scope has none.
    expect(balanceOfEntity(traced.view(), "ent_b", "messages")?.remaining).toBe(1_000);
  });
});

describe("the catalog surface", () => {
  it("carries `pooled` from a plan item into the standing's allowances", () => {
    const state = subscribed();

    expect(allowancesOf(state).messages?.pooled).toBe(true);
  });

  it("declares the entity vocabulary the rest of the slice names", () => {
    expect(new AttachEntity({ entityId: entA })._tag).toBe("AttachEntity");
    expect(typeof feature).toBe("function");
  });
});

describe("a pooled item that bills", () => {
  /** One customer, one pooled item that bills its overage at two cents a unit. */
  const billedPool = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
    subscribed({
      plans: planSet(
        planRow("pro", {
          allowances: {
            messages: allowance(messages, {
              included: 100,
              overage: "bill",
              cap: 10_000,
              unitPrice: { amount: 2, currency: "usd" },
              pooled: true,
            }),
          },
        }),
      ),
      remaining: { messages: 100 },
      ...overrides,
    });

  it("prices a child scope's draw with the pool's terms, not the scope's", () => {
    const traced = scenario(billedPool());
    traced.step(new AttachEntity({ entityId: entA, name: "A" }));

    const result = traced.step(new TrackUsage({ feature: "messages", amount: 150, entity: entA }));

    const event =
      result._tag === "Accepted"
        ? (result.events.find((entry) => entry._tag === "UsageRecorded") as
            | {
                readonly charge?: number;
                readonly billable?: number;
                readonly poolAfter?: number;
                readonly poolDrawn?: number;
              }
            | undefined)
        : undefined;

    // The scope has no source of its own, so all 150 units are the pool's: 50
    // of them are past its included 100 and bill two cents each.
    expect(event?.charge).toBe(100);
    expect(event?.billable).toBe(50);
    expect(event?.poolDrawn).toBe(150);
    expect(event?.poolAfter).toBe(-50);

    // The pool's own counter and the customer's bill are both foldable now.
    expect(traced.state._tag === "Subscribed" && traced.state.poolSpent?.messages).toBe(150);
    expect(traced.state._tag === "Subscribed" && traced.state.billed?.messages).toBe(100);
  });

  it("starts the pool's spent count over at the boundary", () => {
    const traced = scenario(billedPool());
    traced.step(new AttachEntity({ entityId: entA, name: "A" }));
    traced.step(new TrackUsage({ feature: "messages", amount: 150, entity: entA }));
    traced.step(new ClosePeriod({ periodEnd: monthLater }), monthLater);

    const result = traced.step(new TrackUsage({ feature: "messages", amount: 50, entity: entA }));

    const event =
      result._tag === "Accepted"
        ? (result.events.find((entry) => entry._tag === "UsageRecorded") as
            | { readonly charge?: number; readonly poolAfter?: number }
            | undefined)
        : undefined;

    // The new window includes 100 again, so the first 50 bill nothing and the
    // counter measures this window's draw only.
    expect(event?.charge).toBe(0);
    expect(event?.poolAfter).toBe(50);
    expect(traced.state._tag === "Subscribed" && traced.state.poolSpent?.messages).toBe(50);
  });

  it("refuses a child scope's draw at the customer's ceiling", () => {
    const traced = scenario(
      billedPool({ billingControls: { spendLimits: [{ featureId: "messages", amount: 100 }] } }),
    );

    traced.step(new AttachEntity({ entityId: entA, name: "A" }));
    traced.step(new TrackUsage({ feature: "messages", amount: 150, entity: entA }));

    const refused = traced.step(
      new TrackUsage({ feature: "messages", amount: 10, entity: entA }),
    ) as { readonly _tag: string; readonly rejection?: { readonly _tag: string } };

    // The ceiling is the customer's, and it judged the pool's spend from a
    // child scope, which is the only scope the turn runs in.
    expect(refused._tag).toBe("Rejected");
    expect(refused.rejection?._tag).toBe("SpendLimitExceeded");
  });
});
