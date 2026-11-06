import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { subscribeInputOf } from "../../src/TierCommand.ts";

const base = { amount: 1_900, currency: "usd", interval: "month" as const };
const eur = { amount: 1_800, currency: "eur", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price: { ...base, additionalCurrencies: [{ currency: "eur", amount: 1_800 }] },
  grants: [allowance(messages, { included: 100 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const account = Subscription.ref("acct_currency");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

it.effect(
  "subscribes in the currency the caller asks for, at the amount the catalog states",
  () => {
    const input = subscribeInputOf(testCatalog, "pro", { currency: "eur" })!;
    return story(
      Story.provide(Actor, system("test")),
      Story.clock(start),
      Story.when(account, new Subscribe(input)),
      Story.then(
        account,
        new SubscriptionActivated({
          tier: "pro",
          credits: 0,
          creditsExpire: "period",
          rates: input.rates,
          allowances: input.allowances,
          remaining: { messages: 100 },
          periodStart: start,
          periodEnd: monthLater,
          anchorTz: "UTC",
          interval: "month",
          currency: "eur",
          price: eur,
          statusAfter: "active",
        }),
      ),
      Story.view(Entitlements, account, {
        periodEnd: monthLater,
        currency: "eur",
        features: {
          messages: {
            included: 100,
            used: 0,
            reserved: 0,
            remaining: 100,
            carried: 0,
            allowed: true,
            overage: "block",
            resets: "month",
            resetsAt: monthLater,
          },
        },
      }),
    );
  },
);
