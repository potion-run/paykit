import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { DevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Resume, ScheduleCancellation } from "../../src/Billing/Cancel.binding.ts";
import { ChangeTier } from "../../src/Billing/ChangeTier.binding.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { ConsumeCredits } from "../../src/Billing/ConsumeCredits.binding.ts";
import { Hold } from "../../src/Billing/Hold.binding.ts";
import { List } from "../../src/Billing/List.binding.ts";
import { ChargeProration, Portal } from "../../src/Billing/Portal.binding.ts";
import { Preview as PreviewBinding } from "../../src/Billing/Preview.binding.ts";
import { ReleaseHold } from "../../src/Billing/ReleaseHold.binding.ts";
import {
  ScheduleTierChange,
  WithdrawTierChange,
} from "../../src/Billing/ScheduleTierChange.binding.ts";
import { SettleHold } from "../../src/Billing/SettleHold.binding.ts";
import { StartTrial } from "../../src/Billing/StartTrial.binding.ts";
import { Subscribe as SubscribeBinding } from "../../src/Billing/Subscribe.binding.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { Webhook } from "../../src/Billing/Webhook.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

/**
 * A catalog that exercises every shape the bindings answer:
 * - `messages` is a blocking meter, so a request past it is refused.
 * - `emails` is postpaid, so usage bills money and the answer carries `billed`.
 * - `ai` is priced in credits by dimension, so usage spends the pool.
 */
const emails = feature({ id: "emails", name: "Emails" });
const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });

const testCatalog = Effect.runSync(
  catalog({
    features: [messages, emails, ai],
    tiers: [
      tier({
        id: "pro",
        price: { amount: 1900, currency: "usd", interval: "month" },
        credits: 5000,
        grants: [
          allowance(messages, { included: 2000 }),
          allowance(emails, {
            included: 0,
            overage: "bill",
            unitPrice: { amount: 1, currency: "usd" },
          }),
        ],
      }),
      tier({
        id: "free",
        credits: 1000,
        grants: [
          allowance(messages, { included: 100 }),
          allowance(emails, {
            included: 0,
            overage: "bill",
            unitPrice: { amount: 1, currency: "usd" },
          }),
        ],
      }),
    ],
  }),
);

const account = "acct_binding" as AccountId;

/** The model, its guards and its store — what both worlds share. */
const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

/** The bindings in the process that hosts the model. */
const inProcessWorld = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(Layer.provideMerge(Model));

/** The tenant bundle with no provider: a capability error, not a crash. */
const worldWithoutProvider = Layer.mergeAll(BillingInProcess, catalogLayer(testCatalog)).pipe(
  Layer.provideMerge(Model),
);

/** The tenant bundle behind the manual provider: invoice, no portal. */
const worldManual = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsManual().payments,
).pipe(Layer.provideMerge(Model));

/**
 * The same bindings over `BillingApi`: its `Session` middleware, its encoders
 * and its reply decoding are all on the path.
 */
const apiWorld = Layer.mergeAll(
  BillingApiLayer,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  // Consumed, not merged: how the binding authenticates is the layer's business,
  // not something a caller has to provide.
  Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": account } })),
);

/**
 * Every service the stories reach: the bindings the Api also serves, and the
 * model behind them. `ChangeTier` is not here — it needs the standing to compute
 * a proration, so it is an in-process operation with its own test.
 */
type World = Layer.Success<typeof apiWorld>;

/**
 * One body, both transports. Every claim a binding makes has to hold whichever
 * way the call reaches the model, so no assertion is written twice.
 */
const both = <A, E>(name: string, body: () => Effect.Effect<A, E, World>) => {
  const run = () => body();
  it.live(`${name} over the model`, () => run().pipe(Effect.provide(inProcessWorld)));
  it.live(`${name} over the Api`, () => run().pipe(Effect.provide(apiWorld)));
};

const subscribe = Effect.gen(function* () {
  const subscribe = yield* subscribeOperation();
  yield* subscribe({ account, tier: "free" });
});

describe("paykit bindings", () => {
  both("answers blocked before a standing exists", () =>
    Effect.gen(function* () {
      const check = yield* Check(account);
      const answer = yield* check({ feature: "messages", amount: 1 });
      expect(answer.allowed).toBe(false);
      expect(answer.standing).toBe("blocked");
      expect(answer.remaining).toBe(0);
    }),
  );

  both("records usage, replays a retry, and refuses past the block", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const trackUsage = yield* TrackUsage(account);

      const first = yield* trackUsage({ feature: "messages", amount: 30, dedupeKey: "u-1" });
      expect(first.remaining).toBe(70);
      expect(first.used).toBe(30);
      expect(first.reserved).toBe(0);

      const replay = yield* trackUsage({ feature: "messages", amount: 30, dedupeKey: "u-1" });
      expect(replay.remaining).toBe(70);
      expect(replay.used).toBe(30);

      const refused = yield* Effect.exit(
        trackUsage({ feature: "messages", amount: 71, dedupeKey: "u-2" }),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("AllowanceExceeded");

      const after = yield* (yield* Check(account))({ feature: "messages", amount: 0 });
      expect(after.remaining).toBe(70);
      expect(after.allowed).toBe(true);
    }),
  );

  both("bills postpaid usage and reports the period's money", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const trackUsage = yield* TrackUsage(account);
      const record = yield* trackUsage({ feature: "emails", amount: 25, dedupeKey: "mail-1" });
      expect(record.billed).toBe(25);
      expect(record.used).toBe(25);
    }),
  );

  both("spends the credit pool by dimension and reports the cost", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const trackUsage = yield* TrackUsage(account);
      const used = yield* trackUsage({
        feature: "ai",
        amount: 2,
        dimension: "gpt-large",
        dedupeKey: "ai-1",
      });
      expect(used.cost).toBe(20);
      expect(used.credits).toBe(980);

      const refused = yield* Effect.exit(
        trackUsage({ feature: "ai", amount: 100, dimension: "gpt-large", dedupeKey: "ai-2" }),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("CreditExceeded");
    }),
  );

  both("holds capacity, settles what ran, and returns the rest", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const hold = yield* Hold(account);
      const settleHold = yield* SettleHold(account);
      const check = yield* Check(account);

      const placed = yield* hold({ feature: "messages", amount: 10, dedupeKey: "turn-1" });
      expect(placed.holdId).toBe("turn-1");
      expect(placed.remaining).toBe(90);

      // Held units are out of `remaining` and visible as `reserved`.
      expect((yield* check({ feature: "messages", amount: 0 })).remaining).toBe(90);
      expect((yield* check({ feature: "messages", amount: 91 })).allowed).toBe(false);

      const settled = yield* settleHold({
        holdId: placed.holdId,
        amount: 4,
        dedupeKey: "turn-1:settle",
      });
      expect(settled.billed).toBe(4);
      expect(settled.released).toBe(6);
      expect((yield* check({ feature: "messages", amount: 0 })).remaining).toBe(96);

      // Settling the same hold again records nothing: the retry answers the first reply.
      const replay = yield* settleHold({
        holdId: placed.holdId,
        amount: 4,
        dedupeKey: "turn-1:settle",
      });
      expect(replay.billed).toBe(4);
      expect(replay.released).toBe(6);
    }),
  );

  both("releases a hold without billing it", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const hold = yield* Hold(account);
      const releaseHold = yield* ReleaseHold(account);
      const check = yield* Check(account);

      const placed = yield* hold({ feature: "messages", amount: 10, dedupeKey: "job-1" });
      expect(placed.remaining).toBe(90);

      const released = yield* releaseHold({ holdId: placed.holdId, dedupeKey: "job-1:release" });
      expect(released.released).toBe(10);
      expect((yield* check({ feature: "messages", amount: 0 })).remaining).toBe(100);
    }),
  );

  both("refuses a settle of a hold nobody placed", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const settleHold = yield* SettleHold(account);
      const refused = yield* Effect.exit(
        settleHold({ holdId: "never-placed", amount: 1, dedupeKey: "s-1" }),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("HoldUnknown");
    }),
  );

  both("spends credits from the pool and refuses past the balance", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const consumeCredits = yield* ConsumeCredits(account);
      const { balance } = yield* consumeCredits({ amount: 40, dedupeKey: "spend-1" });
      expect(balance).toBe(960);

      const replay = yield* consumeCredits({ amount: 40, dedupeKey: "spend-1" });
      expect(replay.balance).toBe(960);

      const refused = yield* Effect.exit(consumeCredits({ amount: 2000, dedupeKey: "spend-2" }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("CreditExceedsBalance");
      }
    }),
  );

  both("schedules a cancellation and takes it back", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const cancel = yield* ScheduleCancellation(account);
      const resume = yield* Resume(account);

      expect((yield* cancel({ dedupeKey: "cancel-1" })).cancelAtPeriodEnd).toBe(true);
      expect((yield* resume({ dedupeKey: "resume-1" })).cancelAtPeriodEnd).toBe(false);

      // Resume after the cancellation is withdrawn has nothing to undo.
      const refused = yield* Effect.exit(resume({ dedupeKey: "resume-2" }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("NotScheduled");
    }),
  );

  it.live("changes tier, computing the proration from the standing", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const changeTier = yield* ChangeTier(account);
      const moved = yield* changeTier({ tier: "pro", dedupeKey: "upgrade-1" });
      expect(moved.tier).toBe("pro");
      // Free to pro mid-period is a positive proration: the part of the month
      // left, at pro's price.
      expect(moved.proration).not.toBe(null);
      if (moved.proration !== null) {
        expect(moved.proration.due).toBeGreaterThan(0);
        expect(moved.proration.currency).toBe("usd");
      }

      // A tier id is branded from the catalog; an unknown one is a decode
      // failure at the boundary, which is the point of the brand.
      const unknown = yield* Effect.exit(changeTier({ tier: "nope", dedupeKey: "upgrade-2" }));
      expect(unknown._tag).toBe("Failure");
      if (unknown._tag === "Failure") expect(String(unknown.cause)).toContain("TierNotInCatalog");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  both("schedules a tier change for the boundary and takes it back", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const schedule = yield* ScheduleTierChange(account);
      const withdraw = yield* WithdrawTierChange(account);

      expect((yield* schedule({ tier: "pro", dedupeKey: "move-1" })).pendingTier).toBe("pro");
      expect((yield* withdraw({ dedupeKey: "move-2" })).pendingTier).toBe(null);

      const refused = yield* Effect.exit(withdraw({ dedupeKey: "move-3" }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("NoTierChangeScheduled");
      }
    }),
  );

  both("opens a trial on the tier's cadence, once", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const startTrial = yield* StartTrial(account);
      const deadline = DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 14 });

      const started = yield* startTrial({
        tier: "pro",
        trialEndsAt: deadline,
        dedupeKey: "trial-1",
      });
      expect(started.tier).toBe("pro");
      expect(started.status).toBe("trialing");
      expect(started.trialEndsAt).not.toBe(null);

      const again = yield* Effect.exit(
        startTrial({
          tier: "pro",
          trialEndsAt: DateTime.add(deadline, { days: 1 }),
          dedupeKey: "trial-2",
        }),
      );
      expect(again._tag).toBe("Failure");
      if (again._tag === "Failure") expect(String(again.cause)).toContain("TrialAlreadyUsed");
    }),
  );

  both("refuses a trial deadline that is not after the start", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const startTrial = yield* StartTrial(account);
      const past = DateTime.subtract(DateTime.makeUnsafe(Date.now()), { days: 1 });
      const refused = yield* Effect.exit(
        startTrial({ tier: "pro", trialEndsAt: past, dedupeKey: "trial-past" }),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("TrialDeadlineNotLater");
      }
    }),
  );

  it.live("sells a tier through the provider's purchase path", () =>
    Effect.gen(function* () {
      const subscribe = yield* SubscribeBinding(account);
      // A free tier activates and waits for the view, so a Check right after sees it.
      expect(yield* subscribe({ tier: "free" })).toEqual({ activated: true });
      expect((yield* (yield* Check(account))({ feature: "messages", amount: 1 })).allowed).toBe(
        true,
      );

      // A priced tier opens the provider's path; the standing activates when the
      // webhook arrives, not here.
      const purchase = yield* subscribe({ tier: "pro" });
      expect("url" in purchase && purchase.url).toContain("checkout");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("quotes a change before it is sent, and reports a refusal as data", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const preview = yield* PreviewBinding(account);

      const quoted = yield* preview({ command: { kind: "changeTier", tier: "pro" } });
      expect(quoted._tag).toBe("accepted");
      if (quoted._tag === "accepted") {
        expect(quoted.proration?.due ?? 0).toBeGreaterThan(0);
        expect(quoted.events.length).toBeGreaterThan(0);
      }

      // A tier the catalog does not carry cannot be previewed at all: that is a
      // caller error, so it fails typed rather than coming back as `rejected`.
      const unknown = yield* Effect.exit(
        preview({ command: { kind: "changeTier", tier: "nope" } }),
      );
      expect(unknown._tag).toBe("Failure");
      if (unknown._tag === "Failure") expect(String(unknown.cause)).toContain("TierNotInCatalog");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("opens the provider's portal, and answers a capability error without one", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const portal = yield* Portal(account);
      // `PaymentsMemory` sells and portals; a provider without one refuses typed.
      expect((yield* portal()).url).toContain(account);
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("charges the proration a tier change recorded, once", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const changeTier = yield* ChangeTier(account);
      const chargeProration = yield* ChargeProration(account);

      // Nothing to collect before a change moved money.
      const nothing = yield* chargeProration();
      expect(nothing.outcome).toBe("nothing");

      yield* changeTier({ tier: "pro", dedupeKey: "upgrade-charge" });
      const charged = yield* chargeProration();
      expect(charged.outcome).toBe("charged");
      expect(charged.amount ?? 0).toBeGreaterThan(0);
      expect(charged.invoiceId).toBeDefined();

      // The invoice id is recorded, so a second call answers `nothing`.
      expect((yield* chargeProration()).outcome).toBe("nothing");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("pages every account, in one cursor order", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const list = yield* List();
      const page = yield* list({ take: 10 });
      expect(page.rows.map((row) => row.account)).toContain(account);
      expect(page.asOf).toBeDefined();
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("applies a delivery once, keyed by the provider's event id", () =>
    Effect.gen(function* () {
      // Its own account: the in-memory platform is shared by every test in this
      // file, so a delivery against `account` would meet a standing that exists.
      const hookee = "acct_webhook" as AccountId;
      const webhook = yield* Webhook();
      const event = {
        id: "evt_1",
        provider: "manual",
        kind: "checkout_completed" as const,
        account: hookee,
        tier: "free",
      };

      expect(yield* webhook(event)).toBe("activated");
      // A redelivery is a replay: same id, same command, nothing recorded twice.
      expect(yield* webhook(event)).toBe("ignored");
      // And a *new* event for a standing that exists is ignored too, because a
      // second activation would reset the period and forget what was recorded.
      expect(yield* webhook({ ...event, id: "evt_2" })).toBe("ignored");
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("a portal without a provider answers a capability error, not a crash", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const portal = yield* Portal(account);
      const refused = yield* Effect.exit(portal());
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("ProviderCapabilityMissing");
      }
    }).pipe(Effect.provide(worldWithoutProvider)),
  );

  it.live("the manual provider sells through an invoice and has no portal", () =>
    Effect.gen(function* () {
      const subscribe = yield* SubscribeBinding(account);
      const purchase = yield* subscribe({ tier: "pro" });
      expect("invoiceId" in purchase).toBe(true);
      const portal = yield* Portal(account);
      const refused = yield* Effect.exit(portal());
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("ProviderCapabilityMissing");
      }
    }).pipe(Effect.provide(worldManual)),
  );

  it.live("the account is the bind, so a request cannot name another", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const trackUsage = yield* TrackUsage(account);
      // `account` is not a field of the request: the type carries it, and a
      // second account in the payload would not compile.
      const result = yield* trackUsage({ feature: "messages", amount: 1, dedupeKey: "one" });
      expect(result.used).toBe(1);
    }).pipe(Effect.provide(inProcessWorld)),
  );
});
