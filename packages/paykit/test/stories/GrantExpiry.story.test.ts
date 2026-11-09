import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, planItemsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BalanceExpired } from "../../src/Subscription/ExpireGrant.command.ts";
import { BalanceGranted, GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 10 })] });

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free] }));
const allowances = planItemsOf(testCatalog, "free")!;

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const account = Subscription.ref("acct_grant_expiry");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const dayLater = at("2030-01-02T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const activated = new SubscriptionActivated({
  tier: "free",
  credits: 0,
  creditsExpire: "period",
  rates: {},
  allowances,
  remaining: { messages: 10 },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  statusAfter: "active",
});

const opened = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({ tier: "free", allowances, credits: 0, creditsExpire: "period", rates: {} }),
    { commandId: "open" },
  ),
  Story.then(account, activated),
];

it.effect("an expiring grant leaves the balance at its deadline", () =>
  story(
    ...opened,
    Story.when(
      account,
      new GrantBalance({
        feature: "messages",
        granted: 5,
        expiresAt: dayLater,
      }),
      { commandId: "grant:expiring" },
    ),
    Story.then(
      account,
      new BalanceGranted({
        feature: "messages",
        grantId: "grant:expiring",
        granted: 5,
        expiresAt: dayLater,
        planId: "free",
        remainingAfter: 15,
      }),
    ),
    // The policy scheduled the deadline; when it fires the grant leaves, and the
    // plan's ten are untouched.
    Story.clock(dayLater),
    Story.then(
      account,
      new BalanceExpired({
        feature: "messages",
        grantId: "grant:expiring",
        amount: 5,
        balanceAfter: 10,
      }),
    ),
  ),
);

it.effect("a lifetime grant has no deadline, so it survives every clock change", () =>
  story(
    ...opened,
    Story.when(account, new GrantBalance({ feature: "messages", granted: 5 }), {
      commandId: "grant:lifetime",
    }),
    Story.then(
      account,
      new BalanceGranted({
        feature: "messages",
        grantId: "grant:lifetime",
        granted: 5,
        planId: "free",
        remainingAfter: 15,
      }),
    ),
    // Five days later: no period boundary, and no expiry scheduled.
    Story.clock(at("2030-01-06T00:00:00Z")),
    Story.then(account),
  ),
);
