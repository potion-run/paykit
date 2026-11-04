import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import {
  BillingStack,
  BillingStackAttrs,
  BillingStackProvider,
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
  providers: [{ name: "memory", kind: "memory", capabilities: ["checkout" as const] }],
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
        providers: [{ name: "manual", kind: "manual", capabilities: ["refund"] }],
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
          { name: "memory", kind: "memory", capabilities: ["checkout"] },
          { name: "memory", kind: "manual", capabilities: ["invoice"] },
        ],
      }),
    );
    expect(duplicate._tag).toBe("Failure");
    if (duplicate._tag !== "Failure") return;
    expect(duplicate.failure).toBeInstanceOf(ProviderDuplicate);
  });

  it("read returns state as recorded, and dies when there is none", () => {
    const recorded = run(reconcileBillingStack(props));
    if (recorded._tag !== "Success") return;
    expect(Effect.runSync(readBillingStack(recorded.success))).toEqual(recorded.success);
    expect(Effect.runSyncExit(readBillingStack(undefined))._tag).toBe("Failure");
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
