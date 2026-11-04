import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { asSystem } from "./Auth/Actor.ts";
import { allowancesOf, tierOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import {
  type PaymentError,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentsService,
} from "./Payments.ts";
import { AttachProviderRef } from "./Subscription/AttachProviderRef.command.ts";
import { Entitlements } from "./Subscription/Entitlements.view.ts";
import { Subscribe as SubscribeCommand } from "./Subscription/Subscribe.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "./Subscription/TierNotInCatalog.rejection.ts";

/** What `Subscribe` asks for. */
export interface SubscribeInput {
  readonly account: string;
  readonly tier: string;
  /** The account's period anchor. Defaults to UTC. */
  readonly anchorTz?: string;
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
  amount: number,
  currency: string,
): Effect.Effect<{ readonly url: string } | { readonly invoiceId: string }, PaymentError> => {
  if (provider !== null) {
    if (provider.capabilities.has("checkout")) {
      return service.createCheckout({ account, tier });
    }
    if (provider.capabilities.has("invoice")) {
      return service.createInvoice({ account, amount, currency });
    }
    return Effect.fail(
      new ProviderCapabilityMissing({ provider: provider.name, op: "createCheckout" }),
    );
  }
  return service
    .createCheckout({ account, tier })
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
export const Subscribe = Effect.fn("Paykit.Subscribe")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  const payments = yield* Effect.serviceOption(Payments);
  const provider = yield* Effect.serviceOption(PaymentsProvider);

  return Effect.fn("Paykit.Subscribe.start")(function* (input: SubscribeInput) {
    const tier = tierOf(catalog, input.tier);
    const allowances = allowancesOf(catalog, input.tier);
    if (tier === null || allowances === null) {
      return yield* new TierNotInCatalog({ tier: input.tier });
    }
    const ref = Subscription.ref(input.account);
    const anchored = input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz };

    if (tier.price === undefined) {
      const receipt = yield* asSystem(
        subscription.send(ref, new SubscribeCommand({ tier: tier.id, allowances, ...anchored })),
      );
      yield* entitlements.query(ref, { atLeast: receipt });
      return { activated: true } as const satisfies SubscribeResult;
    }

    if (Option.isNone(payments)) {
      return yield* new ProviderCapabilityMissing({ provider: "none", op: "createCheckout" });
    }
    const service = Option.getOrThrow(payments);
    const providerName = Option.match(provider, {
      onNone: () => "provider",
      onSome: (found) => found.name,
    });
    const purchase = yield* purchasePath(
      service,
      Option.getOrNull(provider),
      input.account,
      tier.id,
      tier.price.amount,
      tier.price.currency,
    );
    // The reference is stored before any standing exists, so a webhook that
    // activates the account can find the purchase it belongs to.
    const reference = "url" in purchase ? purchase.url : purchase.invoiceId;
    yield* subscription.send(
      ref,
      new AttachProviderRef({ provider: providerName, refs: { checkout: reference } }),
      { commandId: `checkout:${input.account}:${tier.id}:${reference}` },
    );
    return purchase as SubscribeResult;
  });
});
