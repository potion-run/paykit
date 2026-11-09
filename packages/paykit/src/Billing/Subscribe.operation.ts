import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  providerFor,
} from "../Payments.ts";
import { AlreadySubscribed } from "../Subscription/AlreadySubscribed.rejection.ts";
import { AttachProviderRef } from "../Subscription/AttachProviderRef.command.ts";
import { Entitlements } from "../Subscription/Entitlements.view.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { Subscribe as SubscribeCommand } from "../Subscription/Subscribe.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { isTerminalStatus } from "../Subscription/Subscription.state.ts";
import { priceFor } from "../Tier.ts";
import { subscribeInputOf } from "../TierCommand.ts";

/** What `Subscribe` asks for. */
export interface SubscribeInput {
  readonly account: string;
  readonly tier: string;
  /** The account's period anchor. Defaults to UTC. */
  readonly anchorTz?: string;
  /** The currency to sell in. Omitted means the tier's base currency. */
  readonly currency?: string;
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
 */
const purchasePath = (
  service: PaymentsService,
  provider: { readonly name: string; readonly capabilities: ReadonlySet<string> } | null,
  account: string,
  tier: string,
  kind: "subscription" | "one_off",
  amount: number,
  currency: string,
): Effect.Effect<{ readonly url: string } | { readonly invoiceId: string }, PaymentError> => {
  if (provider !== null) {
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
 * @primitive
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

    const resolvedPrice =
      tier.price === undefined
        ? undefined
        : input.currency === undefined
          ? tier.price
          : priceFor(tier.price, input.currency);

    if (tier.price !== undefined && resolvedPrice === null) {
      return yield* new PlanNotInCatalog({ tier: input.tier });
    }

    const ref = Subscription.ref(input.account);

    const anchored = {
      ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
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

    if (resolvedPrice === undefined) {
      // A one-off tier is a pack of credits; without a price there is nothing
      // to buy. The catalog refuses this shape, so a runtime that sees it has
      // a stale catalog rather than a caller mistake.
      if (kind === "one_off") {
        return yield* new PlanNotInCatalog({ tier: input.tier });
      }

      const activation = subscribeInputOf(catalog, input.tier, anchored);

      if (activation === null) {
        return yield* new PlanNotInCatalog({ tier: input.tier });
      }

      const receipt = yield* asSystem(subscription.send(ref, new SubscribeCommand(activation)));
      yield* entitlements.query(ref, { atLeast: receipt });

      return { activated: true } as const satisfies SubscribeResult;
    }

    // A pack is a purchase, not an activation: the account keeps whatever
    // standing it has (or has none yet), and the payment path is the only thing
    // that runs. Buying one never creates a second standing.
    // Bound here: narrowing a property does not survive into the generator.
    if (resolvedPrice === null) {
      return yield* new PlanNotInCatalog({ tier: input.tier });
    }

    const price = resolvedPrice;

    // The standing says which provider this account already belongs to; a new
    // account starts on the router's fallback. One provider's layer is provided
    // for this call, because two providers are two services.
    const chosen = Option.match(router, {
      onNone: () => null,
      onSome: (set) => providerFor(set, standing.refs),
    });

    const attempt = Effect.gen(function* () {
      const payments = yield* Effect.serviceOption(Payments);
      const provider = yield* Effect.serviceOption(PaymentsProvider);

      if (Option.isNone(payments)) {
        return yield* new ProviderCapabilityMissing({
          provider: chosen?.name ?? "none",
          op: "createCheckout",
        });
      }

      const service = Option.getOrThrow(payments);
      const providerName = chosen?.name ?? Option.getOrNull(provider)?.name ?? "provider";

      const purchase = yield* purchasePath(
        service,
        Option.getOrNull(provider),
        input.account,
        tier.id,
        kind,
        price.amount,
        price.currency,
      );

      // The reference is stored before any standing exists, so a webhook that
      // activates the account can find the purchase it belongs to.
      const reference = "url" in purchase ? purchase.url : purchase.invoiceId;
      yield* subscription.send(
        ref,
        new AttachProviderRef({ provider: providerName, refs: { checkout: reference } }),
        { commandId: `checkout:${input.account}:${tier.id}:${reference}` },
      );

      // SAFETY: the purchase result is built by this operation; the cast names the public alias.
      return purchase as SubscribeResult;
    });

    return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.payments);
  });
});
