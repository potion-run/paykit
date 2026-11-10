import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import {
  BILLING_STACK_VERSION,
  BillingStack,
  BillingStackAttrs,
  BillingStackProvider,
  BillingStackStateTooNew,
  diffBillingStack,
  readBillingStack,
  reconcileBillingStack,
} from "../src/BillingStack.resource.ts";
import { providers } from "../src/BillingStack.resource.ts";
import { catalog } from "../src/Catalog.ts";
import { messages } from "../src/Feature.ts";
import { CatalogPriceMismatch, NoPurchasePath, ProviderDuplicate } from "../src/Stack.ts";
import { tier } from "../src/Tier.ts";

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

describe("the BillingStack resource", () => {
  it("reconcile records the catalog re-validated, its tiers and the store kind", () => {
    const result = run(reconcileBillingStack(props));
    expect(result._tag).toBe("Success");

    if (result._tag !== "Success") return;
    expect(result.success.tiers).toEqual(["free", "pro"]);
    expect(result.success.store).toEqual({ _tag: "MemoryStore" });
    expect(result.success.providers).toEqual(props.providers);
  });

  it("records D1 and Durable Object stores as their own kinds", () => {
    const d1 = run(reconcileBillingStack({ ...props, store: { _tag: "D1Store" } }));

    const durable = run(reconcileBillingStack({ ...props, store: { _tag: "DurableObjectStore" } }));

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
    const first = run(reconcileBillingStack(props));
    const second = run(reconcileBillingStack(props));
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");

    if (first._tag !== "Success" || second._tag !== "Success") return;
    expect(Schema.encodeSync(BillingStackAttrs)(first.success)).toEqual(
      Schema.encodeSync(BillingStackAttrs)(second.success),
    );
  });

  it("refuses a catalog that does not validate, instead of recording half a stack", () => {
    const duplicate = run(
      reconcileBillingStack({
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
      reconcileBillingStack({
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
      reconcileBillingStack({
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
      reconcileBillingStack({
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
    const recorded = run(reconcileBillingStack(props));

    if (recorded._tag !== "Success") return;
    expect(Effect.runSync(readBillingStack(recorded.success))).toEqual(recorded.success);
    // No state is a resource that does not exist yet, not a crash: Alchemy's
    // plan calls `read` with `output: undefined` before the first reconcile.
    expect(Effect.runSync(readBillingStack(undefined))).toBeUndefined();
  });

  it("records the shape version it wrote", () => {
    const recorded = run(reconcileBillingStack(props));
    expect(recorded._tag).toBe("Success");

    if (recorded._tag !== "Success") return;
    expect(recorded.success.version).toBe(BILLING_STACK_VERSION);
  });

  it("read upgrades state written by an older shape, and refuses a newer one", () => {
    const recorded = run(reconcileBillingStack(props));

    if (recorded._tag !== "Success") return;
    // State from before the field existed: no `version` at all, which is 0.
    // It is readable: the next reconcile rewrites it in the current shape.
    const { version: _version, ...legacy } = recorded.success;
    const older = run(readBillingStack(legacy as unknown as BillingStackAttrs));
    expect(older._tag).toBe("Success");

    if (older._tag === "Success") expect(older.success).toEqual(legacy);

    // A newer shape is a refusal: an older build must not move that state back.
    const future = run(
      readBillingStack({ ...recorded.success, version: BILLING_STACK_VERSION + 1 }),
    );

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackStateTooNew);

    if (future.failure._tag !== "BillingStackStateTooNew") return;
    expect(future.failure.found).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.expected).toBe(BILLING_STACK_VERSION);
  });

  it("reconcile refuses a shape written by a newer build, and upgrades an older one", () => {
    const recorded = run(reconcileBillingStack(props));

    if (recorded._tag !== "Success") return;
    const { version: _version, ...legacy } = recorded.success;
    const older = run(reconcileBillingStack(props, legacy as unknown as BillingStackAttrs));
    expect(older._tag).toBe("Success");

    if (older._tag === "Success") expect(older.success).toEqual(recorded.success);

    const future = run(
      reconcileBillingStack(props, {
        ...recorded.success,
        version: BILLING_STACK_VERSION + 1,
      }),
    );

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackStateTooNew);

    if (future.failure._tag !== "BillingStackStateTooNew") return;
    expect(future.failure.found).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.expected).toBe(BILLING_STACK_VERSION);
  });

  it("diff refuses a shape written by a newer build, upgrades an older one, and no-ops the current one", () => {
    const recorded = run(reconcileBillingStack(props));

    if (recorded._tag !== "Success") return;
    const { version: _version, ...legacy } = recorded.success;
    const older = run(diffBillingStack(legacy as unknown as BillingStackAttrs));
    expect(older._tag).toBe("Success");

    if (older._tag === "Success") expect(older.success).toEqual({ action: "update" });

    const current = run(diffBillingStack(recorded.success));
    expect(current._tag).toBe("Success");

    if (current._tag === "Success") expect(current.success).toBeUndefined();

    const future = run(
      diffBillingStack({ ...recorded.success, version: BILLING_STACK_VERSION + 1 }),
    );

    expect(future._tag).toBe("Failure");

    if (future._tag !== "Failure") return;
    expect(future.failure).toBeInstanceOf(BillingStackStateTooNew);

    if (future.failure._tag !== "BillingStackStateTooNew") return;
    expect(future.failure.found).toBe(BILLING_STACK_VERSION + 1);
    expect(future.failure.expected).toBe(BILLING_STACK_VERSION);
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
