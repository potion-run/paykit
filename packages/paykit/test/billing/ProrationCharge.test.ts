import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { BillingReadStore, MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { ChargeProration } from "../../src/ChargeProration.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
} from "../../src/Payments.ts";
import { prorate } from "../../src/Proration.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { NoProrationDue } from "../../src/Subscription/RecordProrationInvoice.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

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
const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const scale = allowancesOf(testCatalog, "scale")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const scalePrice = { amount: 9900, currency: "usd", interval: "month" as const };
const account = "acct_proration";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const end = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
/** The whole period is unused at its start, so an upgrade owes credit − charge. */
const upgrade = prorate({ from: proPrice, to: scalePrice, period: { start, end }, at: start })!;
const downgrade = prorate({ from: scalePrice, to: undefined, period: { start, end }, at: start })!;

interface Invoice {
  readonly amount: number;
  readonly currency: string;
}

/** A provider that records the invoices it was asked to open. */
const invoicing = (asked: Array<Invoice>, failWith?: PaymentDeclined) =>
  Layer.merge(
    Payments.toLayer(
      Effect.succeed({
        createCheckout: () =>
          Effect.fail(new ProviderCapabilityMissing({ provider: "test", op: "createCheckout" })),
        createInvoice: (args: { account: string; amount: number; currency: string }) =>
          failWith === undefined
            ? Effect.sync(() => {
                asked.push({ amount: args.amount, currency: args.currency });
                return { invoiceId: `inv_${asked.length}` };
              })
            : Effect.fail(failWith),
        refund: () =>
          Effect.fail(new ProviderCapabilityMissing({ provider: "test", op: "refund" })),
        createPortal: () =>
          Effect.fail(new ProviderCapabilityMissing({ provider: "test", op: "createPortal" })),
      }),
    ),
    Layer.succeed(PaymentsProvider, { name: "test", capabilities: new Set(["invoice"] as const) }),
  );

const world = (asked: Array<Invoice>, failWith?: PaymentDeclined) =>
  // `provideMerge` so the projection's store is the one the test reads: a
  // `provide` would give the handlers a private copy.
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
    Layer.provide(Domain.InMemory),
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Actor, system("test")),
        catalogLayer(testCatalog),
        invoicing(asked, failWith),
      ),
    ),
  );

/** Pro, then up to scale: the state now owes `upgrade.due`. */
const upgraded = Effect.gen(function* () {
  const subscription = yield* Subscription;
  const ref = Subscription.ref(account);
  yield* subscription.send(ref, new Subscribe({ tier: "pro", allowances: pro, price: proPrice }));
  yield* subscription.send(
    ref,
    new ChangeTier({
      tier: "scale",
      allowances: scale,
      price: scalePrice,
      proration: upgrade,
    }),
  );
});

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  asked: Array<Invoice>,
  failWith?: PaymentDeclined,
) => effect.pipe(Effect.provide(world(asked, failWith))) as Effect.Effect<A, E, never>;

describe("charging a proration", () => {
  it.live("opens one invoice for the difference an upgrade moved", () => {
    const asked: Array<Invoice> = [];
    return run(
      Effect.gen(function* () {
        yield* upgraded;
        const charge = yield* ChargeProration();
        const result = yield* charge({ account });
        expect(result).toEqual({
          outcome: "charged",
          invoiceId: "inv_1",
          amount: 8000,
          currency: "usd",
        });
        expect(asked).toEqual([{ amount: 8000, currency: "usd" }]);
      }),
      asked,
    );
  });

  it.live("shows the charge and its invoice on the billing page", () => {
    const asked: Array<Invoice> = [];
    return run(
      Effect.gen(function* () {
        yield* upgraded;
        const charge = yield* ChargeProration();
        yield* charge({ account });

        const billing = yield* BillingState;
        // A view is fed by deliveries, so the page catches up just after the
        // command commits; wait for it rather than racing it. The budget is in
        // seconds because a loaded suite delivers slower than a quiet one.
        let page = Option.getOrNull(yield* billing.query(Subscription.ref(account)));
        for (let attempt = 0; attempt < 500 && page?.proration === undefined; attempt++) {
          yield* Effect.sleep("10 millis");
          page = Option.getOrNull(yield* billing.query(Subscription.ref(account)));
        }
        expect(page?.proration).toEqual({
          currency: "usd",
          credit: 1900,
          charge: 9900,
          due: 8000,
        });
        expect(page?.prorationInvoice).toBe("inv_1");

        // And the cross-account row a dashboard reads, not just the page.
        const reads = yield* BillingReadStore;
        const row = yield* reads.get(account);
        expect(row?.proration?.due).toBe(8000);
        expect(row?.prorationInvoice).toBe("inv_1");
      }),
      asked,
    );
  });

  it.live("bills once: a second call is refused, not a second invoice", () => {
    const asked: Array<Invoice> = [];
    return run(
      Effect.gen(function* () {
        yield* upgraded;
        const charge = yield* ChargeProration();
        yield* charge({ account });
        const second = yield* Effect.flip(charge({ account }));
        expect(second).toBeInstanceOf(NoProrationDue);
        expect((second as NoProrationDue).reason).toBe("billed");
        expect(asked.length).toBe(1);
      }),
      asked,
    );
  });

  it.live("a standing with no tier change has nothing to charge", () => {
    const asked: Array<Invoice> = [];
    return run(
      Effect.gen(function* () {
        const subscription = yield* Subscription;
        yield* subscription.send(
          Subscription.ref(account),
          new Subscribe({ tier: "pro", allowances: pro, price: proPrice }),
        );
        const charge = yield* ChargeProration();
        const error = yield* Effect.flip(charge({ account }));
        expect(error).toBeInstanceOf(NoProrationDue);
        expect((error as NoProrationDue).reason).toBe("none");
        expect(asked).toEqual([]);
      }),
      asked,
    );
  });

  it.live("a downgrade credit is recorded, never charged", () => {
    const asked: Array<Invoice> = [];
    return run(
      Effect.gen(function* () {
        const subscription = yield* Subscription;
        const ref = Subscription.ref(account);
        yield* subscription.send(
          ref,
          new Subscribe({ tier: "scale", allowances: scale, price: scalePrice }),
        );
        yield* subscription.send(
          ref,
          new ChangeTier({ tier: "free", allowances: free, proration: downgrade }),
        );
        const charge = yield* ChargeProration();
        const error = yield* Effect.flip(charge({ account }));
        // `due` is negative: the account is owed, and paying it out is a refund,
        // which is a provider action rather than a subscription one.
        expect(error).toBeInstanceOf(NoProrationDue);
        expect(asked).toEqual([]);
      }),
      asked,
    );
  });

  it.live("a provider that refuses the invoice leaves nothing recorded", () => {
    const asked: Array<Invoice> = [];
    const refused = new PaymentDeclined({
      provider: "test",
      code: "card_declined",
      message: "card_declined",
    });
    return run(
      Effect.gen(function* () {
        yield* upgraded;
        const charge = yield* ChargeProration();
        const error = yield* Effect.flip(charge({ account }));
        expect(error).toBeInstanceOf(PaymentDeclined);
        const subscription = yield* Subscription;
        const state = yield* subscription.state(Subscription.ref(account));
        // No invoice id, so the charge can be retried rather than lost.
        if (state._tag === "Subscribed") expect(state.prorationInvoice).toBeUndefined();
      }),
      asked,
      refused,
    );
  });
});
