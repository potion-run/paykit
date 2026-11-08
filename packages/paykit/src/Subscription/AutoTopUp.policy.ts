import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { asSystem } from "../Auth/Actor.ts";
import { creditRatesOf, tierOf, type Catalog } from "../Catalog.ts";
import type { CreditRateCards } from "../Feature.ts";
import { Payments, PaymentsRouter, ProviderCapabilityMissing, providerFor } from "../Payments.ts";
import type { Price, TopUpTerms } from "../Tier.ts";
import { CreditsConsumed } from "./ConsumeCredits.command.ts";
import { PurchaseCredits } from "./PurchaseCredits.command.ts";
import { RecordTopUpFailure } from "./RecordTopUpFailure.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { creditsOf, standingTierOf, topUpCooldownOf, topUpOf } from "./Subscription.state.ts";
import { TopUpCooldownCleared, TopUpCooldownElapsed } from "./TopUpCooldownElapsed.command.ts";
import { UsageRecorded } from "./TrackUsage.command.ts";

/** A spend that can take an account's pool across the threshold. */
export type CreditSpend = UsageRecorded | CreditsConsumed;

/** One pack a crossing may buy, resolved from the catalog when the layer is built. */
export interface AutoTopUpPack {
  /** The `kind: "one_off"` tier that is bought. */
  readonly tier: string;
  /** Credits the pack grants. */
  readonly amount: number;
  /** What the pack costs, copied onto the purchase event as evidence. */
  readonly price: Price;
}

/**
 * The packs a deployment may buy, resolved from the catalog when the layer is
 * built. The line itself is not here: it is the standing's, because it differs
 * by tier. `decide` never sees this; only the policy does.
 */
export interface AutoTopUpTerms {
  /** The pack a standing buys when its tier names none. */
  readonly fallback: AutoTopUpPack;
  /**
   * Every pack a tier names, by id, resolved once. A tier that states a
   * `topUp.pack` selects from this table; the catalog has already refused a
   * name nothing sells, so a miss here means the two disagreed.
   */
  readonly packs: ReadonlyMap<string, AutoTopUpPack>;
  /** The catalog's rate cards, so a pack can be spent before a plan exists. */
  readonly rates: CreditRateCards;
  /**
   * The shortest time between two policy-opened purchases, or `null` for none.
   * A tier that states its own cooldown overrides this; the pack is the only
   * bound when neither does.
   */
  readonly cooldown: Duration.Duration | null;
}

/**
 * A deployment that asked for auto top-up but named a tier that cannot be
 * bought. It refuses the layer rather than starting with a policy that can
 * never fire.
 */
export class AutoTopUpInvalid extends Schema.TaggedError<AutoTopUpInvalid>()("AutoTopUpInvalid", {
  /** The tier id the deployment named as the pack. */
  pack: Schema.String,
  /** What is wrong with the pack. */
  reason: Schema.Literals(["unknown-pack", "not-a-pack", "no-credits", "no-price"]),
}) {}

/**
 * A standing named a pack the layer never resolved. The catalog refuses a name
 * that is not a one-off tier, so this means a standing and the catalog it was
 * sold from have disagreed — a defect, not a refusal, because a crossing is not
 * the place to discover it and there is no second pack to fall back to.
 */
export class TopUpPackUnresolved extends Schema.TaggedError<TopUpPackUnresolved>()(
  "TopUpPackUnresolved",
  { tier: Schema.String, pack: Schema.String },
) {}

/** What `Paykit.autoTopUp` resolves once: the pack to buy. */
export class AutoTopUpConfig extends Context.Service<AutoTopUpConfig, AutoTopUpTerms>()(
  "paykit/AutoTopUp",
) {}

/**
 * The auto top-up policy's configuration. The pack is catalog data by id; the
 * threshold is the tier's own field (`Tier.topUp`), so a free tier and an
 * enterprise tier refill on the lines their pools need. The cooldown is the
 * deployment's: it bounds how often one account can be charged, not what the
 * pack costs.
 *
 * ### Refilling a pool from a pack
 * **Example:** Buy the tier's own pack when a pro account falls to 5k credits,
 * at most once an hour
 * ```typescript
 * const pro = Paykit.tier({
 *   id: "pro",
 *   price: { amount: 1_900, currency: "usd", interval: "month" },
 *   credits: 50_000,
 *   topUp: { threshold: 5_000, cooldown: Duration.hours(1), pack: "credits_100k" },
 *   grants: [Paykit.allowance(messages, { included: 2_000 })],
 * });
 *
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
 *       Paykit.autoTopUp({ catalog, pack: credits.id, cooldown: Duration.hours(1) }).pipe(
 *         Layer.orDie,
 *       ),
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 */
export const autoTopUp = (options: {
  readonly catalog: Catalog;
  /**
   * The `kind: "one_off"` pack a tier buys when it names none; its credits and
   * price come from the catalog. A tier that states `topUp.pack` buys that one
   * instead.
   */
  readonly pack: string;
  /**
   * The shortest time between two policy-opened purchases, for every tier that
   * does not state its own. Absent, only a tier's own cooldown or the pack
   * itself bounds a refill.
   */
  readonly cooldown?: Duration.Duration;
}): Layer.Layer<AutoTopUpConfig, AutoTopUpInvalid> =>
  Layer.effect(
    AutoTopUpConfig,
    Effect.gen(function* () {
      const fallback = yield* resolvePack(options.catalog, options.pack);
      // Every pack a tier names is resolved once, here, so a crossing never
      // reads the catalog. The catalog has already refused a name that is not
      // a one-off tier with credits and a price, so this loop cannot fail for a
      // catalog this layer was given; it still reports the pack it refused if
      // the two ever disagree.
      const packs = new Map<string, AutoTopUpPack>([[fallback.tier, fallback]]);

      for (const tier of options.catalog.tiers) {
        const named = tier.topUp?.pack;

        if (named === undefined || packs.has(named)) continue;
        packs.set(named, yield* resolvePack(options.catalog, named));
      }

      return {
        fallback,
        packs,
        rates: creditRatesOf(options.catalog),
        cooldown: options.cooldown ?? null,
      } satisfies AutoTopUpTerms;
    }),
  );

/** One pack, resolved from the catalog, or the reason it cannot be bought. */
const resolvePack = (
  catalog: Catalog,
  packId: string,
): Effect.Effect<AutoTopUpPack, AutoTopUpInvalid> =>
  Effect.gen(function* () {
    const pack = tierOf(catalog, packId);

    if (pack === null) {
      return yield* new AutoTopUpInvalid({ pack: packId, reason: "unknown-pack" });
    }

    if ((pack.kind ?? "subscription") !== "one_off") {
      return yield* new AutoTopUpInvalid({ pack: packId, reason: "not-a-pack" });
    }

    if (pack.credits === undefined || pack.credits <= 0) {
      return yield* new AutoTopUpInvalid({ pack: packId, reason: "no-credits" });
    }

    if (pack.price === undefined) {
      return yield* new AutoTopUpInvalid({ pack: packId, reason: "no-price" });
    }

    return { tier: pack.id, amount: pack.credits, price: pack.price } satisfies AutoTopUpPack;
  });

/**
 * The pack a standing's line buys: the one its tier names, or the deployment's
 * default when it names none.
 */
export const packFor = (terms: AutoTopUpTerms, pack: string | undefined): AutoTopUpPack | null =>
  pack === undefined ? terms.fallback : (terms.packs.get(pack) ?? null);

/**
 * The bound on how often one account may be charged: the tier's own cooldown,
 * then the deployment's, then none at all.
 */
export const topUpCooldownFor = (
  terms: AutoTopUpTerms,
  line: TopUpTerms,
): Duration.Duration | null => line.cooldown ?? terms.cooldown;

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
 * The id of the deadline that ends the cooldown a crossing opened. Derived from
 * the crossing, so a redelivered spend schedules the same deadline once.
 */
export const topUpCooldownCommandId = (account: string, seq: number): string =>
  `topup-cooldown:${account}:${seq}`;

/**
 * The id of the record a crossing writes when its refill could not be bought.
 * Derived from the crossing like the purchase's, so a redelivered spend records
 * the failure it already recorded rather than one per attempt.
 */
export const topUpFailureCommandId = (account: string, seq: number): string =>
  `topup-failed:${account}:${seq}`;

/** The tag of a provider's refusal, for a record an operator can match. */
const failureTag = (error: unknown): string => {
  // SAFETY: the port's failures are tagged errors, and a value that is not one
  // has no `_tag`, which the check on the next line catches.
  const tag = (error as { readonly _tag?: unknown } | null)?._tag;

  return typeof tag === "string" ? tag : "unknown";
};

/**
 * When a spend takes an account's credit pool across its tier's top-up line,
 * buy the pack the deployment named: open an invoice for its price with the
 * account's provider, then record the purchase.
 *
 * The threshold is the standing's, carried on the tier's events, so a free
 * tier and an enterprise tier refill on the lines their pools need. A tier
 * without `topUp` never refills, and an account with no standing has no tier
 * to read a line from; a tier change moves the line for the next spend rather
 * than buying retroactively.
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
 *
 * A deployment that sets a `cooldown` bounds how often one account can be
 * charged. A crossing inside the cooldown is deferred rather than dropped: the
 * deadline that clears it is itself an input, and when it arrives the policy
 * asks the same question of the pool — is it still at or below the line? — and
 * buys then. The deadline is recorded on the purchase, so a replay reproduces
 * the standing without reading a clock.
 */
export class AutoTopUp extends Domain.Policy("AutoTopUp", {
  from: Subscription,
  on: [UsageRecorded, CreditsConsumed, TopUpCooldownCleared],
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

      const standing = yield* subscriptions.state(key);
      // The line is the tier's, not the deployment's: a tier that never stated
      // one never refills, however the pack is configured.
      const line = topUpOf(standing);

      if (line === null) return;
      const threshold = line.threshold;

      // While a cooldown is open the deadline is the only thing that may buy,
      // and it buys through its own event below. Dropping the crossing here is
      // what defers it instead of buying a second pack inside the window.
      if (topUpCooldownOf(standing) !== null) return;

      // A spend has to cross the line; the end of a cooldown only has to leave
      // the pool under it, because the crossing already happened and was
      // deferred. Either way the pool is re-read: the event is the crossing,
      // but the policy runs later, and a pool that has recovered means this
      // pass is a redelivery rather than a new need.
      const due =
        event._tag === "TopUpCooldownCleared"
          ? creditsOf(standing) <= threshold
          : crossedThreshold(event, threshold);

      if (!due) return;

      if (creditsOf(standing) > threshold) return;

      // The product is the standing's line first and the deployment's second:
      // a free tier and an enterprise tier refill the pools they have.
      const pack = packFor(config, line.pack);

      if (pack === null) {
        return yield* Effect.die(
          new TopUpPackUnresolved({
            tier: standingTierOf(standing) ?? "none",
            pack: line.pack ?? "none",
          }),
        );
      }

      // The bound on how often one account is charged is the tier's, so a
      // scheduled change moves it at the boundary with the line and the pack.
      const cooldown = topUpCooldownFor(config, line);

      const chosen = providerFor(router, standing.refs);
      const canCharge = chosen !== null && chosen.capabilities.has("charge");
      const canInvoice = chosen !== null && chosen.capabilities.has("invoice");

      if (chosen === null || (!canCharge && !canInvoice)) {
        return yield* Effect.die(
          new ProviderCapabilityMissing({
            provider: chosen?.name ?? "none",
            op: "createInvoice",
          }),
        );
      }

      const commandId = topUpCommandId(key.id, envelope.seq);
      // The deadline is measured from the crossing's own commit time, which the
      // event already carries: a policy that read a clock would answer
      // differently on a redelivery, and the standing would record a deadline
      // the log does not explain.
      const cooldownUntil = cooldown === null ? null : DateTime.addDuration(envelope.at, cooldown);

      // The deadline is written before the purchase that records it: a crash
      // between the two leaves a command that fires against a standing with no
      // cooldown (a no-op), never a cooldown nothing clears.
      if (cooldownUntil !== null) {
        yield* subscriptions
          .schedule(key, new TopUpCooldownElapsed(), {
            at: cooldownUntil,
            commandId: topUpCooldownCommandId(key.id, envelope.seq),
          })
          .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
      }

      const purchase = Effect.gen(function* () {
        const payments = yield* Effect.serviceOption(Payments);

        if (Option.isNone(payments)) {
          return yield* new ProviderCapabilityMissing({
            provider: chosen.name,
            op: "createInvoice",
          });
        }

        const service = payments.value;

        // Charge the saved method when the provider has one, because that is
        // money taken at the crossing rather than money collected later. A
        // charge that fails falls back to the invoice: a card that did not work
        // is not an account that may not be refilled, and the invoice is the
        // record paykit already keeps.
        const money = {
          account: key.id,
          amount: pack.price.amount,
          currency: pack.price.currency,
          commandId,
        };

        const invoice = service
          .createInvoice(money)
          .pipe(Effect.map(({ invoiceId }) => ({ invoiceId })));

        const paid = yield* canCharge
          ? service.charge(money).pipe(
              Effect.map(({ chargeId }) => ({ chargeId })),
              Effect.catch(() =>
                canInvoice
                  ? invoice
                  : Effect.fail(
                      new ProviderCapabilityMissing({
                        provider: chosen.name,
                        op: "createInvoice",
                      }),
                    ),
              ),
            )
          : invoice;

        // A redelivery is the same command id, which the store resolves to the
        // receipt it already recorded rather than a second pack.
        yield* asSystem(
          subscriptions.send(
            key,
            new PurchaseCredits({
              tier: pack.tier,
              amount: pack.amount,
              price: pack.price,
              rates: config.rates,
              ...paid,
              ...(cooldownUntil === null ? {} : { cooldownUntil }),
            }),
            { commandId },
          ),
        );
      });

      // A refill that could not be bought is a fact the deployment has to see:
      // nothing was charged and nothing was granted, so the pool is where the
      // crossing left it and the standing would otherwise read as if no
      // crossing happened. The failure becomes state rather than a defect —
      // a declined card is business, not a bug — and the cooldown the crossing
      // opened is what retries it (ADR 0027).
      //
      // The account's own provider, never every provider in the router: a
      // second one must not invoice the same crossing.
      const outcome = yield* Effect.provide(purchase, chosen.payments).pipe(Effect.result);

      if (Result.isFailure(outcome)) {
        yield* asSystem(
          subscriptions.send(
            key,
            new RecordTopUpFailure({
              tier: pack.tier,
              price: pack.price,
              provider: chosen.name,
              reason: failureTag(outcome.failure),
            }),
            { commandId: topUpFailureCommandId(key.id, envelope.seq) },
          ),
        ).pipe(Effect.catchCause(() => Effect.void));
      }
    });
  }),
);
