import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { allowance } from "../src/Allowance.ts";
import {
  BILLING_STACK_VERSION,
  BillingStack as BillingStackResource,
} from "../src/BillingStack.resource.ts";
import { catalog } from "../src/Catalog.ts";
import { messages } from "../src/Feature.ts";
import { providers } from "../src/Providers.ts";
import { tier } from "../src/Tier.ts";

const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 100 })],
});

const parsed = Effect.runSync(catalog({ features: [messages], tiers: [pro] }));

const props = {
  catalog: parsed,
  providers: [
    { name: "memory", kind: "memory", webhook: false, capabilities: ["checkout" as const] },
  ],
  store: { _tag: "MemoryStore" as const },
};

const { test } = Test.make({ providers: providers() });

test.provider("deploys the stack, records its version and no-ops the next deploy", (stack) =>
  Effect.gen(function* () {
    const first = yield* stack.deploy(BillingStackResource("Billing", props));
    expect(first.version).toBe(BILLING_STACK_VERSION);

    const second = yield* stack.deploy(BillingStackResource("Billing", props));
    expect(second).toEqual(first);

    // The engine only re-runs `reconcile` for an update, so the second deploy
    // must plan a no-op and keep the recorded attributes byte for byte.
    const plan = yield* stack.plan(BillingStackResource("Billing", props));
    expect(Object.values(plan.resources)[0]?.action).toBe("noop");
  }),
);
