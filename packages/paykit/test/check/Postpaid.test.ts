import { describe, expect, it } from "@alchemy.run/test";
import { evaluateCheck } from "../../src/Check.ts";

const unitPrice = { amount: 2, currency: "usd" };
const account = "acct_postpaid_check";

/**
 * `check()` prices the requested amount before it compares it to a money cap.
 * A read that only compared units would say yes to a request the write refuses.
 */
describe("a postpaid read", () => {
  const state = {
    standing: "good" as const,
    features: {
      messages: {
        included: 100,
        used: 350,
        reserved: 0,
        remaining: -250,
        carried: 0,
        allowed: true,
        overage: "bill" as const,
        resets: "month" as const,
        resetsAt: null,
        pricing: { _tag: "unit" as const, unitPrice },
        moneyCap: 500,
        billed: 400,
      },
    },
  };

  it("allows what fits under the money cap, priced from the billable part", () => {
    // The 350 used are past the included 100, so every extra unit is billable:
    // 50 × 2 = 100, and 400 + 100 is exactly the ceiling.
    expect(evaluateCheck(state, { account, feature: "messages", amount: 50 }).allowed).toBe(true);
  });

  it("refuses the request that would pass the ceiling", () => {
    // 51 × 2 = 102, so 400 + 102 > 500 while `remaining` would still allow the
    // units. The money ceiling is the stricter rule.
    expect(evaluateCheck(state, { account, feature: "messages", amount: 51 }).allowed).toBe(false);
  });

  it("bills only the part of the request that crosses `included`", () => {
    const below = {
      ...state,
      features: {
        messages: {
          ...state.features.messages,
          used: 50,
          remaining: 50,
          billed: 0,
        },
      },
    };
    // 100 more units cross the 100 included by 50: 50 × 2 = 100, under the cap.
    expect(evaluateCheck(below, { account, feature: "messages", amount: 100 }).allowed).toBe(true);
    // 200 more cross by 150: 300, still under. 250 more cross by 200: 400.
    expect(evaluateCheck(below, { account, feature: "messages", amount: 250 }).allowed).toBe(true);
  });
});
