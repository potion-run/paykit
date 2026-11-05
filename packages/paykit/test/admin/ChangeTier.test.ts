import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AdminChangeTier, AdminChangeTierLive } from "../../src/Admin/ChangeTier.ts";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const scaleTier = tier({
  id: "scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5_000 })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const proAllowances = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = "acct_change";

const Base = Layer.mergeAll(
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
    .pipe(Layer.provide(Domain.InMemory))
    .pipe(Layer.provideMerge(MemoryBillingReadStore)),
  catalogLayer(testCatalog),
  Layer.succeed(Actor, system("test")),
);

const World = AdminChangeTierLive.pipe(Layer.provideMerge(Base));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const subscribeToPro = Effect.gen(function* () {
  const subscription = yield* Subscription;
  yield* subscription.send(
    Subscription.ref(account),
    new Subscribe({
      tier: "pro",
      allowances: proAllowances,
      price: proPrice,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  );
});

it.live("quotes a tier change without recording it", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const quote = yield* change.change({ account, tier: "scale" });
    expect(quote._tag).toBe("quoted");
    if (quote._tag !== "quoted") return;
    expect(quote.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("pro");
  }).pipe(run),
);

it.live("applies only the proration the operator confirmed", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const quote = yield* change.change({ account, tier: "scale" });
    expect(quote._tag).toBe("quoted");
    if (quote._tag !== "quoted") return;

    const applied = yield* change.change({
      account,
      tier: "scale",
      expected: quote.proration,
      commandId: "cmd_change",
    });
    expect(applied._tag).toBe("applied");
    if (applied._tag !== "applied") return;
    expect(applied.commandId).toBe("cmd_change");
    expect(applied.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("scale");
  }).pipe(run),
);

it.live("returns a requote instead of applying a different amount", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const wrong = { currency: "usd", credit: 0, charge: 0, due: 0 };
    const answer = yield* change.change({
      account,
      tier: "scale",
      expected: wrong,
      commandId: "cmd_wrong",
    });
    expect(answer._tag).toBe("requote");
    if (answer._tag !== "requote") return;
    expect(answer.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("pro");
  }).pipe(run),
);

it.live("refuses a change with no standing, and a tier the catalog lacks", () =>
  Effect.gen(function* () {
    const change = yield* AdminChangeTier;
    const noStanding = yield* change.change({ account, tier: "scale" });
    expect(noStanding._tag).toBe("rejected");
    if (noStanding._tag === "rejected") {
      expect(noStanding.rejection._tag).toBe("NotSubscribed");
    }

    const unknown = yield* change.change({ account, tier: "enterprise" });
    expect(unknown._tag).toBe("rejected");
    if (unknown._tag === "rejected") {
      expect(unknown.rejection._tag).toBe("TierNotInCatalog");
    }
  }).pipe(run),
);
