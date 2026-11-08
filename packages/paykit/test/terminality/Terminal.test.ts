import { describe, expect, it } from "@alchemy.run/test";
import type { SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import {
  type CommandPlan,
  type Script,
  type ScriptStep,
  commandOf,
  decideAt,
  start,
  walk,
} from "../properties/Arbitraries.ts";

const step = (command: CommandPlan, advanceDays = 0): ScriptStep => ({ command, advanceDays });
const script = (...steps: ReadonlyArray<ScriptStep>): Script => ({ steps });

const declined = (plan: CommandPlan, state: SubscriptionState) =>
  decideAt(state, commandOf(plan, state, start), start, `terminal-${plan._tag}`);

const expired = walk(
  script(
    step({ _tag: "Subscribe", tier: "free" }),
    step({ _tag: "EnterGrace" }),
    step({ _tag: "Expire" }),
  ),
).state;

const canceled = walk(
  script(
    step({ _tag: "Subscribe", tier: "free" }),
    step({ _tag: "ScheduleCancellation" }),
    step({ _tag: "PeriodEnded" }, 40),
  ),
).state;

describe("a terminal standing", () => {
  it("refuses the commands that need an open period", () => {
    for (const state of [expired, canceled]) {
      expect(declined({ _tag: "ChangeTier", tier: "pro" }, state)).toMatchObject({
        _tag: "StandingEnded",
      });
      expect(declined({ _tag: "ScheduleTierChange", tier: "pro" }, state)).toMatchObject({
        _tag: "StandingEnded",
      });
      expect(declined({ _tag: "ConsumeCredits", amount: 1 }, state)).toMatchObject({
        _tag: "StandingEnded",
      });
    }
  });

  it("still accepts goodwill, a pack purchase and a provider ref", () => {
    for (const state of [expired, canceled]) {
      expect(declined({ _tag: "GrantCredits", amount: 10 }, state)).toEqual([
        expect.objectContaining({ _tag: "CreditsGranted" }),
      ]);
      expect(declined({ _tag: "PurchaseCredits", amount: 10 }, state)).toEqual([
        expect.objectContaining({ _tag: "CreditsPurchased" }),
      ]);
      expect(declined({ _tag: "AttachProviderRef" }, state)).toEqual([
        expect.objectContaining({ _tag: "ProviderRefAttached" }),
      ]);
    }
  });
});
