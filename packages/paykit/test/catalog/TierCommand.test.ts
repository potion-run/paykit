import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog, type Catalog } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  planChangeTier,
  purchaseCreditsInputOf,
  scheduleTierChangeInputOf,
  subscribeInputOf,
} from "../../src/TierCommand.ts";
import { start, subscribedAt, testCatalog as generatedCatalog } from "../properties/Arbitraries.ts";

const messages = feature({ id: "messages", name: "Messages" });

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proPrice = { amount: 1_900, currency: "usd", interval: "month" as const };
const pro = tier({
  id: "pro",
  price: proPrice,
  credits: 5_000,
  topUp: 100,
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});
const packPrice = { amount: 4_900, currency: "usd", interval: "month" as const };
const pack = tier({
  id: "pack",
  kind: "one_off",
  price: packPrice,
  credits: 10_000,
  grants: [],
});

const testCatalog: Catalog = Effect.runSync(
  catalog({ features: [messages], tiers: [free, pro, pack] }),
);

describe("subscribeInputOf", () => {
  it("carries the tier's terms and the anchor the caller states", () => {
    expect(subscribeInputOf(testCatalog, "pro", { anchorTz: "Europe/Berlin" })).toEqual({
      tier: "pro",
      allowances: allowancesOf(testCatalog, "pro"),
      credits: 5_000,
      creditsExpire: "period",
      topUp: 100,
      rates: {},
      price: proPrice,
      anchorTz: "Europe/Berlin",
    });
  });

  it("omits what the tier does not state, so an ordinary plan grows no keys", () => {
    const input = subscribeInputOf(testCatalog, "free");
    expect(input).not.toBe(null);
    if (input === null) return;
    expect(input.credits).toBe(0);
    expect("price" in input).toBe(false);
    expect("topUp" in input).toBe(false);
    expect("anchorTz" in input).toBe(false);
  });

  it("refuses a pack and a tier the catalog does not sell", () => {
    expect(subscribeInputOf(testCatalog, "pack")).toBe(null);
    expect(subscribeInputOf(testCatalog, "missing")).toBe(null);
  });
});

describe("scheduleTierChangeInputOf", () => {
  it("carries the same grant with no anchor", () => {
    expect(scheduleTierChangeInputOf(testCatalog, "pro")).toEqual({
      tier: "pro",
      allowances: allowancesOf(testCatalog, "pro"),
      credits: 5_000,
      creditsExpire: "period",
      topUp: 100,
      rates: {},
      price: proPrice,
    });
  });

  it("refuses a pack and a missing tier, exactly as subscribing does", () => {
    expect(scheduleTierChangeInputOf(testCatalog, "pack")).toBe(null);
    expect(scheduleTierChangeInputOf(testCatalog, "missing")).toBe(null);
  });
});

describe("purchaseCreditsInputOf", () => {
  it("carries a pack's credits, price and rates", () => {
    expect(purchaseCreditsInputOf(testCatalog, "pack")).toEqual({
      tier: "pack",
      amount: 10_000,
      price: packPrice,
      rates: {},
    });
  });

  it("carries the invoice an auto top-up opened", () => {
    expect(purchaseCreditsInputOf(testCatalog, "pack", { invoiceId: "in_123" })?.invoiceId).toBe(
      "in_123",
    );
  });

  it("refuses a subscription tier and a missing tier", () => {
    expect(purchaseCreditsInputOf(testCatalog, "pro")).toBe(null);
    expect(purchaseCreditsInputOf(testCatalog, "missing")).toBe(null);
  });
});

describe("planChangeTier", () => {
  it("quotes the proration the same prices and period would charge", () => {
    const state = subscribedAt("pro");
    const at = DateTime.add(start, { days: 5 });
    const plan = planChangeTier(generatedCatalog, "scale", state, at);
    expect(plan).not.toBe(null);
    if (plan === null) return;

    expect(plan.proration).not.toBe(null);
    expect(plan.input.tier).toBe("scale");
    expect("proration" in plan.input).toBe(true);
    expect(plan.input.proration).toEqual(plan.proration);
  });

  it("has no proration before a standing exists, and still builds the move", () => {
    const plan = planChangeTier(testCatalog, "pro", initialSubscriptionState, start);
    expect(plan).not.toBe(null);
    if (plan === null) return;
    expect(plan.proration).toBe(null);
    expect("proration" in plan.input).toBe(false);
  });

  it("refuses a pack and a tier the catalog does not sell", () => {
    expect(planChangeTier(testCatalog, "pack", initialSubscriptionState, start)).toBe(null);
    expect(planChangeTier(testCatalog, "missing", initialSubscriptionState, start)).toBe(null);
  });
});
