import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { Preview } from "../../src/Billing/Preview.binding.ts";
import { allowancesOf, catalog, tierTermsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { bindingsWorld } from "../support/Bindings.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const scaleTier = tier({
  id: "scale",
  price: { amount: 9900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5000, overage: "block" })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const proAllowances = allowancesOf(testCatalog, "pro")!;
const account = "acct_preview";

const World = bindingsWorld({
  catalog: testCatalog,
  guards: Layer.succeed(Actor, system("test")),
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const eurPriced = (amount: number) => ({
  amount,
  currency: "usd",
  interval: "month" as const,
  additionalCurrencies: [{ currency: "eur", amount }],
});

const eurCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [
      tier({
        id: "pro",
        price: eurPriced(1_900),
        grants: [allowance(messages, { included: 2_000, overage: "bill" })],
      }),
      tier({
        id: "scale",
        price: eurPriced(9_900),
        grants: [allowance(messages, { included: 5_000, overage: "block" })],
      }),
    ],
  }),
);

const EurWorld = bindingsWorld({
  catalog: eurCatalog,
  guards: Layer.succeed(Actor, system("test")),
});

const runEur = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(EurWorld));

it.live("previews a subscribe without recording anything", () =>
  Effect.gen(function* () {
    const preview = yield* Preview(account);
    const result = yield* preview({ command: { kind: "subscribe", tier: "pro" } });
    expect(result._tag).toBe("accepted");
    if (result._tag !== "accepted") return;
    expect(result.state._tag).toBe("Subscribed");
    expect(result.events.map((event) => event._tag)).toEqual(["SubscriptionActivated"]);
    // Nothing was written.
    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag).toBe("Unsubscribed");
  }).pipe(run),
);

it.live("previews the charge a tier change would make", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        price: { amount: 1900, currency: "usd", interval: "month" },
      }),
    );
    const preview = yield* Preview(account);
    const result = yield* preview({ command: { kind: "changeTier", tier: "scale" } });
    expect(result._tag).toBe("accepted");
    if (result._tag !== "accepted") return;
    expect(result.proration?.due).toBe(8000);
    expect(result.proration?.credit).toBe(1900);
  }).pipe(run),
);

it.live("previews a change and a schedule in the standing's currency", () =>
  Effect.gen(function* () {
    const account = "acct_preview_eur";
    const subscription = yield* Subscription;
    const terms = tierTermsOf(eurCatalog, "pro", "eur")!;
    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({
        tier: "pro",
        allowances: terms.allowances,
        credits: terms.credits,
        creditsExpire: terms.creditsExpire,
        rates: terms.rates,
        price: terms.price,
      }),
    );

    const preview = yield* Preview(account);
    const change = yield* preview({ command: { kind: "changeTier", tier: "scale" } });
    expect(change._tag).toBe("accepted");
    if (change._tag !== "accepted") return;
    expect(change.proration?.currency).toBe("eur");
    expect(
      (change.events[0] as { readonly priceAfter?: { readonly currency?: string } }).priceAfter
        ?.currency,
    ).toBe("eur");

    const scheduled = yield* preview({ command: { kind: "scheduleTierChange", tier: "scale" } });
    expect(scheduled._tag).toBe("accepted");
    if (scheduled._tag !== "accepted" || scheduled.state._tag !== "Subscribed") return;
    expect(scheduled.state.pendingTier?.currency).toBe("eur");
    expect(scheduled.state.pendingTier?.price?.currency).toBe("eur");
  }).pipe(runEur),
);

it.live("a preview carries the rejection the write would return", () =>
  Effect.gen(function* () {
    const preview = yield* Preview(account);
    const result = yield* preview({ command: { kind: "changeTier", tier: "scale" } });
    expect(result._tag).toBe("rejected");
    if (result._tag !== "rejected") return;
    // A model refusal is data: the console renders the tag it carries.
    expect((result.rejection as { readonly _tag: string })._tag).toBe("NotSubscribed");
  }).pipe(run),
);

it.live("a preview of a tier the catalog does not carry fails typed", () =>
  Effect.gen(function* () {
    const preview = yield* Preview(account);
    const exit = yield* Effect.exit(
      preview({ command: { kind: "subscribe", tier: "enterprise" } }),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("TierNotInCatalog");
  }).pipe(run),
);

it("a preview's events match what the same command records", () =>
  Effect.gen(function* () {
    const preview = yield* Preview(account);
    const predicted = yield* preview({ command: { kind: "subscribe", tier: "free" } });
    expect(predicted._tag).toBe("accepted");
    if (predicted._tag !== "accepted") return;
    // `predict` runs the same `decide`, so the tag and the period agree with
    // the event the model would record at the same instant.
    const subscription = yield* Subscription;
    const receipt = yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "free",
        allowances: allowancesOf(testCatalog, "free")!,
      }),
    );
    expect(receipt.events.map((event) => event._tag)).toEqual(
      predicted.events.map((event) => event._tag),
    );
  }).pipe(run));

it("the clock a preview decides at is the clock the model used", () =>
  Effect.gen(function* () {
    const preview = yield* Preview(account);
    const result = yield* preview({ command: { kind: "subscribe", tier: "free" } });
    expect(result._tag).toBe("accepted");
    if (result._tag !== "accepted" || result.state._tag !== "Subscribed") return;
    const now = DateTime.makeUnsafe(yield* Effect.sync(() => Date.now()));
    const drift = Math.abs(
      DateTime.toEpochMillis(result.state.period.start) - DateTime.toEpochMillis(now),
    );
    expect(drift).toBeLessThan(5_000);
  }).pipe(run));

it.live("previews scheduling a change without recording it", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        price: { amount: 1900, currency: "usd", interval: "month" },
      }),
    );
    const preview = yield* Preview(account);
    const result = yield* preview({ command: { kind: "scheduleTierChange", tier: "scale" } });
    expect(result._tag).toBe("accepted");
    if (result._tag !== "accepted") return;
    // A scheduled change carries no proration: the period it was scheduled in
    // has ended, so there is nothing to prorate.
    expect(result.proration).toBeUndefined();
    expect(result.events.map((event) => event._tag)).toEqual(["TierChangeScheduled"]);
    expect(result.state._tag === "Subscribed" ? result.state.pendingTier?.tier : undefined).toBe(
      "scale",
    );
    // Nothing was written.
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.pendingTier : "missing").toBeUndefined();
  }).pipe(run),
);

it.live("previews the withdrawal of a scheduled change", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const preview = yield* Preview(account);
    const nothing = yield* preview({ command: { kind: "withdrawTierChange" } });
    expect(nothing._tag).toBe("rejected");
    if (nothing._tag !== "rejected") return;
    expect((nothing.rejection as { readonly _tag: string })._tag).toBe("NotSubscribed");

    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: proAllowances,
        price: { amount: 1900, currency: "usd", interval: "month" },
      }),
    );
    yield* subscription.send(
      Subscription.ref(account),
      new ScheduleTierChange({
        tier: "scale",
        allowances: allowancesOf(testCatalog, "scale")!,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        price: { amount: 9900, currency: "usd", interval: "month" },
      }),
    );

    const result = yield* preview({ command: { kind: "withdrawTierChange" } });
    expect(result._tag).toBe("accepted");
    if (result._tag !== "accepted") return;
    expect(result.events.map((event) => event._tag)).toEqual(["TierChangeWithdrawn"]);
    // The schedule is still there: a preview does not record.
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.pendingTier?.tier : undefined).toBe("scale");
  }).pipe(run),
);
