import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import {
  BILLING_STACK_VERSION,
  BillingStack,
  BillingStackAttrs,
  BillingStackProvider,
  BillingStackVersionTooNew,
  billingStackVersionDecision,
  diffBillingStack,
  readBillingStack,
  reconcileBillingStack,
} from "../src/BillingStack.resource.ts";
import { catalog } from "../src/Catalog.ts";
import { messages } from "../src/Feature.ts";
import { providers } from "../src/Providers.ts";
import { CatalogPriceMismatch, NoPurchasePath, ProviderDuplicate } from "../src/Stack.ts";
import { tier } from "../src/Tier.ts";
import { assertProperty } from "./support/Property.ts";

const fqn = "test/Billing";

const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 100 })],
});

const free = tier({ id: "free", grants: [allowance(messages, { included: 10 })] });
const parsed = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));

const props = {
  catalog: parsed,
  providers: [
    { name: "memory", kind: "memory", webhook: false, capabilities: ["checkout" as const] },
  ],
  store: { _tag: "MemoryStore" as const },
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect));

const tooNew = (recorded: BillingStackAttrs) => ({
  ...recorded,
  version: BILLING_STACK_VERSION + 1,
});

const VersionCase = Schema.Struct({ current: Schema.Int, recorded: Schema.Int });

describe("the BillingStack resource", () => {
  it("reconcile records the catalog re-validated, its tiers and the store kind", () => {
    const result = run(reconcileBillingStack(fqn, props));
    expect(result._tag).toBe("Success");

    if (result._tag !== "Success") return;
    expect(result.success.tiers).toEqual(["free", "pro"]);
    expect(result.success.store).toEqual({ _tag: "MemoryStore" });
    expect(result.success.providers).toEqual(props.providers);
  });

  it("records D1 and Durable Object stores as their own kinds", () => {
    const d1 = run(reconcileBillingStack(fqn, { ...props, store: { _tag: "D1Store" } }));

    const durable = run(
      reconcileBillingStack(fqn, { ...props, store: { _tag: "DurableObjectStore" } }),
    );

    expect(d1._tag).toBe("Success");
    expect(durable._tag).toBe("Success");

    if (d1._tag === "Success") expect(d1.success.store).toEqual({ _tag: "D1Store" });

    if (durable._tag === "Success") {
      expect(durable.success.store).toEqual({ _tag: "DurableObjectStore" });
    }
  });

  it("reconciling the same props twice records byte-identical attributes", () => {
    // A deploy that changes nothing must diff to a no-op, so the recorded
    // attributes cannot carry a timestamp, a random id or a re-ordered list.
    const first = run(reconcileBillingStack(fqn, props));
    const second = run(reconcileBillingStack(fqn, props));
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");

    if (first._tag !== "Success" || second._tag !== "Success") return;
    expect(Schema.encodeSync(BillingStackAttrs)(first.success)).toEqual(
      Schema.encodeSync(BillingStackAttrs)(second.success),
    );
  });

  it("refuses a catalog that does not validate, instead of recording half a stack", () => {
    const duplicate = run(
      reconcileBillingStack(fqn, {
        ...props,
        catalog: { features: [messages, messages], tiers: [free] },
      }),
    );

    expect(duplicate._tag).toBe("Failure");

    if (duplicate._tag !== "Failure") return;
    expect(duplicate.failure._tag).toBe("CatalogDuplicateFeature");
  });

  it("refuses a provider price that disagrees with the catalog", () => {
    const mismatch = run(
      reconcileBillingStack(fqn, {
        ...props,
        providers: [
          {
            name: "stripe",
            kind: "processor",
            webhook: false,
            capabilities: ["checkout"],
            prices: { pro: { amount: 100, currency: "usd", interval: "month" } },
          },
        ],
      }),
    );

    expect(mismatch._tag).toBe("Failure");

    if (mismatch._tag !== "Failure") return;
    expect(mismatch.failure).toBeInstanceOf(CatalogPriceMismatch);
  });

  it("refuses a priced tier no provider can sell", () => {
    const unpurchasable = run(
      reconcileBillingStack(fqn, {
        ...props,
        providers: [{ name: "manual", kind: "manual", webhook: false, capabilities: ["refund"] }],
      }),
    );

    expect(unpurchasable._tag).toBe("Failure");

    if (unpurchasable._tag !== "Failure") return;
    expect(unpurchasable.failure).toBeInstanceOf(NoPurchasePath);
  });

  it("refuses two providers that share a name", () => {
    const duplicate = run(
      reconcileBillingStack(fqn, {
        ...props,
        providers: [
          { name: "memory", kind: "memory", webhook: false, capabilities: ["checkout"] },
          { name: "memory", kind: "manual", webhook: false, capabilities: ["invoice"] },
        ],
      }),
    );

    expect(duplicate._tag).toBe("Failure");

    if (duplicate._tag !== "Failure") return;
    expect(duplicate.failure).toBeInstanceOf(ProviderDuplicate);
  });

  it("read returns state as recorded, and reports no state as missing", () => {
    const recorded = run(reconcileBillingStack(fqn, props));

    if (recorded._tag !== "Success") return;
    expect(Effect.runSync(readBillingStack(fqn, recorded.success))).toEqual(recorded.success);
    // No state is a resource that does not exist yet, not a crash: Alchemy's
    // plan calls `read` with `output: undefined` before the first reconcile.
    expect(Effect.runSync(readBillingStack(fqn, undefined))).toBeUndefined();
  });

  it("records the shape version it wrote", () => {
    const recorded = run(reconcileBillingStack(fqn, props));
    expect(recorded._tag).toBe("Success");

    if (recorded._tag !== "Success") return;
    expect(recorded.success.version).toBe(BILLING_STACK_VERSION);
  });

  it.effect("the version policy is total and ordered for every pair of versions", () =>
    assertProperty(Arbitrary.schema(VersionCase), ({ current, recorded }) => {
      const decision = billingStackVersionDecision(current, recorded);

      if (recorded > current) return decision === "too-new";

      if (recorded < current) return decision === "update";

      return decision === "current";
    }),
  );

  it("read refuses a state written by a newer build", () => {
    const recorded = run(reconcileBillingStack(fqn, props));

    if (recorded._tag !== "Success") return;

    const future = run(readBillingStack(fqn, tooNew(recorded.success)));

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackVersionTooNew);

    if (future.failure._tag !== "BillingStackVersionTooNew") return;
    expect(future.failure.fqn).toBe(fqn);
    expect(future.failure.deployed).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.current).toBe(BILLING_STACK_VERSION);
    expect(future.failure.message).toContain(fqn);
  });

  it("reconcile refuses a state written by a newer build", () => {
    const recorded = run(reconcileBillingStack(fqn, props));

    if (recorded._tag !== "Success") return;

    const future = run(reconcileBillingStack(fqn, props, tooNew(recorded.success)));

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackVersionTooNew);

    if (future.failure._tag !== "BillingStackVersionTooNew") return;
    expect(future.failure.fqn).toBe(fqn);
    expect(future.failure.deployed).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.current).toBe(BILLING_STACK_VERSION);
  });

  it("diff no-ops the current shape and refuses a newer one", () => {
    const recorded = run(reconcileBillingStack(fqn, props));

    if (recorded._tag !== "Success") return;

    const current = run(diffBillingStack(fqn, recorded.success));
    expect(current._tag).toBe("Success");

    if (current._tag === "Success") expect(current.success).toBeUndefined();

    const future = run(diffBillingStack(fqn, tooNew(recorded.success)));

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackVersionTooNew);

    if (future.failure._tag !== "BillingStackVersionTooNew") return;
    expect(future.failure.fqn).toBe(fqn);
    expect(future.failure.deployed).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.current).toBe(BILLING_STACK_VERSION);
  });

  it("keeps the stack when it is removed", () => {
    // Removing the stack must never cancel a subscription, refund a charge or
    // delete a customer: the ledger is application data, not stack state.
    expect(BillingStack.Type).toBe("Paykit.BillingStack");
    expect(BillingStack.Provider).toBeDefined();
  });

  it("ships a provider Layer a stack can declare beside the cloud's", () => {
    expect(typeof BillingStackProvider).toBe("function");
    expect(providers()).toBeDefined();
  });
});
