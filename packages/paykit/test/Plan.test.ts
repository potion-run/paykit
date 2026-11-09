import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Balance } from "../src/Balance.ts";
import { catalog, planItemsOf, planOf } from "../src/Catalog.ts";
import { Customer, CustomerId } from "../src/Customer.ts";
import { messages } from "../src/Feature.ts";
import { Plan, plan } from "../src/Plan.ts";
import { PlanItem, planItem, prorationOf, resetOf, rolloverOf } from "../src/PlanItem.ts";

const pro = plan({
  id: "pro",
  group: "subscription",
  isDefault: false,
  trial: { days: 14, onEnd: "bill" },
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [planItem(messages, { included: 2_000 })],
});

describe("the public plan vocabulary", () => {
  it("declares a plan with its group, trial and plan items", () => {
    expect(Schema.is(Plan)(pro)).toBe(true);
    expect(pro.group).toBe("subscription");
    expect(pro.trial?.days).toBe(14);

    const item = pro.grants[0]!;

    expect(Schema.is(PlanItem)(item)).toBe(true);
    expect(item.feature).toBe(messages.id);
  });

  it("accepts plans in a catalog and resolves them by the public names", () => {
    const declared = Effect.runSync(catalog({ features: [messages], plans: [pro] }));

    expect(declared.tiers).toHaveLength(1);
    expect(planOf(declared, "pro")?.id).toBe("pro");
    expect(planItemsOf(declared, "pro")?.[messages.id]?.included).toBe(2_000);
  });
});

describe("the public plan item, customer and balance shapes", () => {
  it("exposes reset, proration and rollover in the public vocabulary", () => {
    const item = planItem(messages, {
      included: 100,
      carryOver: true,
      carryCap: 20,
      resets: "day",
      resetEvery: 2,
      prorate: "period_end",
    });

    expect(resetOf(item)).toEqual({ interval: "day", count: 2 });
    expect(prorationOf(item)).toEqual({
      onIncrease: "prorate_next_cycle",
      onDecrease: "prorate_next_cycle",
    });
    expect(rolloverOf(item)).toEqual({ max: 20, expiry: "forever" });
  });

  it("carries a customer and a balance with its sources", () => {
    const customer = {
      id: CustomerId.make("cus_1"),
      plans: [{ planId: "pro", version: 1, status: "active" as const }],
      billingControls: {},
      entities: [],
    };

    expect(Schema.is(Customer)(customer)).toBe(true);

    const balance = {
      customerId: "cus_1",
      scope: { kind: "customer" as const },
      featureId: "messages",
      granted: 100,
      remaining: 80,
      usage: 20,
      unlimited: false,
      overageAllowed: false,
      nextResetAt: null,
      breakdown: [
        {
          id: "src_1",
          scope: { kind: "customer" as const },
          kind: "plan" as const,
          granted: 100,
          remaining: 80,
          usage: 20,
          interval: "month",
          planId: "pro",
        },
      ],
    };

    expect(Schema.is(Balance)(balance)).toBe(true);
  });
});
