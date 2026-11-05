import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asSystem } from "../Auth/Actor.ts";
import { creditRatesOf, tierOf, type Catalog } from "../Catalog.ts";
import type { CreditRateCards } from "../Feature.ts";
import { Payments, PaymentsRouter, ProviderCapabilityMissing, providerFor } from "../Payments.ts";
import type { Price } from "../Tier.ts";
import { CreditsConsumed } from "./ConsumeCredits.command.ts";
import { PurchaseCredits } from "./PurchaseCredits.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { creditsOf } from "./Subscription.state.ts";
import { UsageRecorded } from "./TrackUsage.command.ts";

/** A spend that can take an account's pool across the threshold. */
export type CreditSpend = UsageRecorded | CreditsConsumed;

/**
 * The two numbers a deployment states for auto top-up, plus the pack's terms
 * resolved from the catalog when the layer is built. `decide` never sees this;
 * only the policy does.
 */
export interface AutoTopUpTerms {
  /** Credits at or below which a spend is a crossing. */
  readonly threshold: number;
  /** The `kind: "one_off"` tier that is bought. */
  readonly tier: string;
  /** Credits the pack grants. */
  readonly amount: number;
  /** What the pack costs, copied onto the purchase event as evidence. */
  readonly price: Price;
  /** The catalog's rate cards, so a pack can be spent before a plan exists. */
  readonly rates: CreditRateCards;
}

/**
 * A deployment that asked for auto top-up but named a tier that cannot be
 * bought. It refuses the layer rather than starting with a policy that can
 * never fire.
 */
export class AutoTopUpInvalid extends Schema.TaggedError<AutoTopUpInvalid>()("AutoTopUpInvalid", {
  /** The tier id the deployment named as the pack. */
  pack: Schema.String,
  /** What is wrong with it, or with the threshold. */
  reason: Schema.Literals(["threshold", "unknown-pack", "not-a-pack", "no-credits", "no-price"]),
}) {}

/** What `Paykit.autoTopUp` resolves once: the threshold and the pack to buy. */
export class AutoTopUpConfig extends Context.Service<AutoTopUpConfig, AutoTopUpTerms>()(
  "paykit/AutoTopUp",
) {}

/**
 * The auto top-up policy's configuration. The pack is catalog data by id; the
 * threshold is a deployment choice, not a price, so it lives beside the model
 * rather than in the catalog.
 *
 * ### Refilling a pool from a pack
 * **Example:** Buy a 100k pack when the account falls to 5k credits
 * ```typescript
 * const credits = Paykit.tier({
 *   id: "credits_100k",
 *   kind: "one_off",
 *   price: { amount: 4_900, currency: "usd", interval: "month" },
 *   credits: 100_000,
 *   grants: [],
 * });
 *
 * const layer = Paykit.Model.layer(
 *   Paykit.ModelHandlers.pipe(
 *     Layer.provideMerge(Paykit.paymentsRouter(provider)),
 *     Layer.provideMerge(
 *       Paykit.autoTopUp({ catalog, threshold: 5_000, pack: credits.id }).pipe(Layer.orDie),
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 */
export const autoTopUp = (options: {
  readonly catalog: Catalog;
  /** Credits at or below which a spend buys the pack. Zero refills on empty. */
  readonly threshold: number;
  /** The `kind: "one_off"` tier to buy; its credits and price come from the catalog. */
  readonly pack: string;
}): Layer.Layer<AutoTopUpConfig, AutoTopUpInvalid> =>
  Layer.effect(
    AutoTopUpConfig,
    Effect.gen(function* () {
      if (!Number.isInteger(options.threshold) || options.threshold < 0) {
        return yield* new AutoTopUpInvalid({ pack: options.pack, reason: "threshold" });
      }
      const pack = tierOf(options.catalog, options.pack);
      if (pack === null) {
        return yield* new AutoTopUpInvalid({ pack: options.pack, reason: "unknown-pack" });
      }
      if ((pack.kind ?? "subscription") !== "one_off") {
        return yield* new AutoTopUpInvalid({ pack: options.pack, reason: "not-a-pack" });
      }
      if (pack.credits === undefined || pack.credits <= 0) {
        return yield* new AutoTopUpInvalid({ pack: options.pack, reason: "no-credits" });
      }
      if (pack.price === undefined) {
        return yield* new AutoTopUpInvalid({ pack: options.pack, reason: "no-price" });
      }
      return {
        threshold: options.threshold,
        tier: pack.id,
        amount: pack.credits,
        price: pack.price,
        rates: creditRatesOf(options.catalog),
      } satisfies AutoTopUpTerms;
    }),
  );

/**
 * Whether this spend took the pool from above the threshold to at or below it.
 *
 * The balance before the event is on the event itself — `creditsAfter + cost`
 * for metered usage and `balanceAfter + amount` for a manual spend — so the
 * policy needs neither the aggregate nor the clock, and a second event while
 * the pool is already low is not a second crossing.
 */
export const crossedThreshold = (event: CreditSpend, threshold: number): boolean => {
  const before =
    event._tag === "UsageRecorded"
      ? event.cost <= 0
        ? null
        : event.creditsAfter + event.cost
      : event.balanceAfter + event.amount;
  const after = event._tag === "UsageRecorded" ? event.creditsAfter : event.balanceAfter;
  return before !== null && before > threshold && after <= threshold;
};

/**
 * The id a crossing's invoice and command share. The stream and its sequence
 * identify the event, so a redelivery is the same purchase and a different
 * crossing is a different one.
 */
export const topUpCommandId = (account: string, seq: number): string => `topup:${account}:${seq}`;

/**
 * When a spend takes an account's credit pool across the configured threshold,
 * buy the pack the deployment named: open an invoice for its price with the
 * account's provider, then record the purchase.
 *
 * The money and the credits are one record. The invoice is keyed by the
 * crossing, the `PurchaseCredits` command carries that same id, and the event
 * carries the invoice — so a retried policy is the same invoice and the same
 * pack, and a crash between the two is one retry away from the pair landing
 * rather than two packs or an invoice nobody's credits answer.
 *
 * The policy only reacts to spends: grants, expiries, reservations and
 * releases are not crossings, and a crossing whose pool has already recovered
 * is a late delivery rather than a reason to buy. A deployment that never
 * provides `AutoTopUpConfig` pays nothing for this policy.
 */
export class AutoTopUp extends Domain.Policy("AutoTopUp", {
  from: Subscription,
  on: [UsageRecorded, CreditsConsumed],
}) {}

export const AutoTopUpLive = AutoTopUp.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    const config = Option.getOrNull(yield* Effect.serviceOption(AutoTopUpConfig));

    // Resolve the router while the layer is built, like every policy that calls
    // a provider. A deployment that opted in without one would otherwise grant
    // credits no invoice can collect, so it fails at boot instead.
    const router = Option.getOrNull(yield* Effect.serviceOption(PaymentsRouter));
    if (config !== null && router === null) {
      return yield* Effect.die(
        new ProviderCapabilityMissing({ provider: "none", op: "createInvoice" }),
      );
    }

    return Effect.fn("Paykit.AutoTopUp.react")(function* ({ key, event, envelope }) {
      if (config === null || router === null) return;
      if (!crossedThreshold(event, config.threshold)) return;

      const standing = yield* subscriptions.state(key);
      // The event is the crossing, but the policy runs later: a pool that has
      // already recovered means this pass is a redelivery, not a new need.
      if (creditsOf(standing) > config.threshold) return;

      const chosen = providerFor(router, standing.refs);
      if (chosen === null || !chosen.capabilities.has("invoice")) {
        return yield* Effect.die(
          new ProviderCapabilityMissing({
            provider: chosen?.name ?? "none",
            op: "createInvoice",
          }),
        );
      }

      const commandId = topUpCommandId(key.id, envelope.seq);
      const purchase = Effect.gen(function* () {
        const payments = yield* Effect.serviceOption(Payments);
        if (Option.isNone(payments)) {
          return yield* new ProviderCapabilityMissing({
            provider: chosen.name,
            op: "createInvoice",
          });
        }
        const { invoiceId } = yield* payments.value.createInvoice({
          account: key.id,
          amount: config.price.amount,
          currency: config.price.currency,
          commandId,
        });
        // A redelivery is the same command id, which the store resolves to the
        // receipt it already recorded rather than a second pack.
        yield* asSystem(
          subscriptions.send(
            key,
            new PurchaseCredits({
              tier: config.tier,
              amount: config.amount,
              price: config.price,
              rates: config.rates,
              invoiceId,
            }),
            { commandId },
          ),
        );
      });

      // The account's own provider, never every provider in the router: a
      // second one must not invoice the same crossing.
      yield* Effect.provide(purchase, chosen.payments).pipe(Effect.orDie);
    });
  }),
);
