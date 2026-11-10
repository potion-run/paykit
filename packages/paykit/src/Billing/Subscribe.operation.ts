import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Allowance } from "../Allowance.ts";
import { asSystem } from "../Auth/Actor.ts";
import { planOf } from "../Catalog.ts";
import { CatalogService } from "../CatalogService.ts";
import {
  type PaymentError,
  Payments,
  PaymentsProvider,
  PaymentsRouter,
  ProviderCapabilityMissing,
  type PaymentsService,
  resolveProvider,
} from "../Payments.ts";
import { AlreadySubscribed } from "../Subscription/AlreadySubscribed.rejection.ts";
import { AttachProviderRef } from "../Subscription/AttachProviderRef.command.ts";
import { Entitlements } from "../Subscription/Entitlements.view.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { Subscribe as SubscribeCommand } from "../Subscription/Subscribe.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { isTerminalStatus } from "../Subscription/Subscription.state.ts";
import { INITIAL_PLAN_VERSION, priceFor, samePrice, type Price } from "../Tier.ts";
import { subscribeInputOf, withGrants } from "../TierCommand.ts";

/** What `Subscribe` asks for. */
export interface SubscribeInput {
  readonly account: string;
  readonly tier: string;
  /** The account's period anchor. Defaults to UTC. */
  readonly anchorTz?: string;
  /** The currency to sell in. Omitted means the tier's base currency. */
  readonly currency?: string;
  /** The bespoke items a custom plan is activated at, when it states any (ADR 0041). */
  readonly grants?: ReadonlyArray<Allowance>;
  /**
   * The price a custom plan was negotiated at. Omitted means the catalog's
   * price for `currency`; a stated price is the deal and is recorded as such
   * (ADR 0042 §3).
   */
  readonly price?: Price;
}

/** What `Subscribe` gives back: a purchase path, or a free-tier activation. */
export type SubscribeResult =
  | { readonly url: string }
  | { readonly invoiceId: string }
  | { readonly activated: true };

/**
 * Walk the provider's purchase path for a priced tier: a hosted checkout when
 * it has one, a send-invoice when it only has that, and a typed capability
 * error when it has neither. Every provider implements the required port, so
 * this switch is the only place a provider's shape changes the flow.
 *
 * A negotiated price asks for an invoice even when a checkout exists: the
 * vendor's checkout sells the catalog's price object, not an amount, and an
 * invoice is the port that takes the amount the deal states (ADR 0042 §3).
 */
const purchasePath = (
  service: PaymentsService,
  provider: { readonly name: string; readonly capabilities: ReadonlySet<string> } | null,
  account: string,
  tier: string,
  kind: "subscription" | "one_off",
  amount: number,
  currency: string,
  negotiated: boolean,
): Effect.Effect<
  { readonly url: string; readonly reference?: string } | { readonly invoiceId: string },
  PaymentError
> => {
  if (provider !== null) {
    if (negotiated) {
      return provider.capabilities.has("invoice")
        ? service.createInvoice({ account, amount, currency })
        : Effect.fail(
            new ProviderCapabilityMissing({ provider: provider.name, op: "createInvoice" }),
          );
    }

    if (provider.capabilities.has("checkout")) {
      return service.createCheckout({ account, tier, kind });
    }

    if (provider.capabilities.has("invoice")) {
      return service.createInvoice({ account, amount, currency });
    }

    return Effect.fail(
      new ProviderCapabilityMissing({ provider: provider.name, op: "createCheckout" }),
    );
  }

  if (negotiated) return service.createInvoice({ account, amount, currency });

  return service
    .createCheckout({ account, tier, kind })
    .pipe(
      Effect.catchTag("ProviderCapabilityMissing", () =>
        service.createInvoice({ account, amount, currency }),
      ),
    );
};

/**
 * The one door to a purchase. A free tier activates immediately and waits for
 * the `Entitlements` view, so a `Check` straight after a `Subscribe` sees it.
 * A priced tier opens the provider's purchase path (hosted checkout or
 * invoice), stores its opaque reference on the account, and activates when the
 * provider's `payment_succeeded` or `checkout_completed` webhook arrives.
 *
 * There is no second entry point: a caller that needs a checkout calls this.
 *
 * ### Selling a tier
 * **Example:** Subscribe to a free tier, then to a priced one
 * ```typescript
 * const subscribe = yield* Paykit.Subscribe();
 *
 * yield* subscribe({ account, tier: "free" });   // => { activated: true }
 *
 * const purchase = yield* subscribe({ account, tier: "pro" });
 * if ("url" in purchase) return Response.redirect(purchase.url);
 * ```
 *
 */
export const subscribeOperation = Effect.fn("Paykit.Subscribe")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  const router = yield* Effect.serviceOption(PaymentsRouter);

  return Effect.fn("Paykit.Subscribe.start")(function* (input: SubscribeInput) {
    const tier = planOf(catalog, input.tier);

    if (tier === null) {
      return yield* new PlanNotInCatalog({ tier: input.tier });
    }

    const kind = tier.kind ?? "subscription";

    const catalogPrice =
      tier.price === undefined
        ? undefined
        : input.currency === undefined
          ? tier.price
          : priceFor(tier.price, input.currency);

    // A stated price is its own currency, so an unsupported `currency` is only
    // a refusal when the catalog has to resolve the price.
    if (tier.price !== undefined && catalogPrice === null && input.price === undefined) {
      return yield* new PlanNotInCatalog({ tier: input.tier });
    }

    // A pack is a catalog purchase; its price is not negotiated. A plan may be
    // sold at the price the caller states, which is what the event records.
    const price =
      kind === "one_off" ? (catalogPrice ?? undefined) : (input.price ?? catalogPrice ?? undefined);

    // A stated price that is not the catalog's is a negotiated amount, and the
    // provider's checkout cannot sell an amount; it sells the catalog's price
    // object. The invoice path is the one that takes the deal.
    const negotiated =
      kind !== "one_off" &&
      input.price !== undefined &&
      !samePrice(input.price, catalogPrice ?? undefined);

    const ref = Subscription.ref(input.account);

    const anchored = {
      ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
      ...(input.price !== undefined || input.currency === undefined
        ? {}
        : { currency: input.currency }),
    };

    const standing = yield* subscription.state(ref);

    // A pack is a purchase on any standing; a plan is not. Refuse before the
    // provider is asked, so a second checkout cannot take money the model will
    // then decline to activate.
    if (
      kind !== "one_off" &&
      standing._tag === "Subscribed" &&
      !isTerminalStatus(standing.status)
    ) {
      return yield* new AlreadySubscribed({
        account: input.account,
        status: standing.status,
      });
    }

    // The terms an activation would record, before the provider is asked. A
    // bespoke set and a negotiated price are judged by the same guard a wire
    // caller meets, so an in-process attach and an HTTP one cannot disagree
    // about what the plan may grant or what it costs (ADR 0041 §6, ADR 0042).
    const activation = kind === "one_off" ? null : subscribeInputOf(catalog, input.tier, anchored);

    if (kind !== "one_off" && activation === null) {
      return yield* new PlanNotInCatalog({ tier: input.tier });
    }

    const granted =
      activation === null ? null : withGrants(catalog, activation, input.grants, input.price);

    if (granted !== null && granted.mismatch !== null) return yield* granted.mismatch;

    const terms = granted?.input ?? null;

    if (price === undefined) {
      // A one-off tier is a pack of credits; without a price there is nothing
      // to buy. The catalog refuses this shape, so a runtime that sees it has
      // a stale catalog rather than a caller mistake.
      if (kind === "one_off" || terms === null) {
        return yield* new PlanNotInCatalog({ tier: input.tier });
      }

      const receipt = yield* asSystem(subscription.send(ref, new SubscribeCommand(terms)));
      yield* entitlements.query(ref, { atLeast: receipt });

      return { activated: true } as const satisfies SubscribeResult;
    }

    // A pack is a purchase, not an activation: the account keeps whatever
    // standing it has (or has none yet), and the payment path is the only thing
    // that runs. Buying one never creates a second standing.

    // The standing says which provider this account already belongs to; a new
    // account starts on the router's fallback. One provider's context is
    // provided for this call, because two providers are two services.
    const chosen = Option.match(router, {
      onNone: () => null,
      onSome: (set) => resolveProvider(set, standing.refs),
    });

    const attempt = Effect.gen(function* () {
      const payments = yield* Effect.serviceOption(Payments);
      const provider = yield* Effect.serviceOption(PaymentsProvider);

      if (Option.isNone(payments)) {
        return yield* new ProviderCapabilityMissing({
          provider: chosen?.provider.name ?? "none",
          op: "createCheckout",
        });
      }

      const service = Option.getOrThrow(payments);
      const providerName = chosen?.provider.name ?? Option.getOrNull(provider)?.name ?? "provider";

      const purchase = yield* purchasePath(
        service,
        Option.getOrNull(provider),
        input.account,
        tier.id,
        kind,
        price.amount,
        price.currency,
        negotiated,
      );

      // The vendor's own id for the purchase is the reference, not the URL: a
      // completion names the purchase, so the quote has to be keyed by what the
      // provider will quote back (ADR 0044 §1). A provider that cannot name one
      // keeps the URL, which is the best identity it has.
      const reference =
        "url" in purchase ? (purchase.reference ?? purchase.url) : purchase.invoiceId;

      yield* subscription.send(
        ref,
        new AttachProviderRef({
          provider: providerName,
          refs: { checkout: reference },
          ...(terms === null
            ? {}
            : (() => {
                // The first generation is omitted, like a default group, so a
                // quote for an unbumped plan does not grow a field (ADR 0047).
                const { version, ...quoted } = terms;

                return {
                  pending: {
                    reference,
                    terms: {
                      ...quoted,
                      ...(version === undefined || version === INITIAL_PLAN_VERSION
                        ? {}
                        : { version }),
                      ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
                    },
                  },
                };
              })()),
        }),
        { commandId: `checkout:${input.account}:${tier.id}:${reference}` },
      );

      // SAFETY: the purchase result is built by this operation; the cast names the public alias.
      return purchase as SubscribeResult;
    });

    return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.context);
  });
});
