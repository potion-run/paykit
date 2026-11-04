import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { allowancesOf, tierOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import {
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentError,
  type PaymentsService,
} from "./Payments.ts";
import { AttachProviderRef } from "./Subscription/AttachProviderRef.command.ts";
import { Subscribe as SubscribeCommand } from "./Subscription/Subscribe.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "./Subscription/TierNotInCatalog.rejection.ts";
import { handleWebhook, type WebhookEvent } from "./Webhooks.ts";

/** What a checkout starts from. */
export interface CheckoutInput {
  readonly account: string;
  readonly tier: string;
  readonly anchorTz?: string;
}

/** What starting a checkout gives back. */
export type CheckoutResult =
  | { readonly url: string }
  | { readonly invoiceId: string }
  | { readonly activated: true };

/**
 * Start a purchase. A free tier activates now; a priced tier opens the
 * provider's purchase path and stores its opaque reference on the account,
 * before any standing exists. The provider webhook completes it.
 */
export const Checkout = Effect.fn("Paykit.Checkout")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const payments = yield* Effect.serviceOption(Payments);
  const provider = yield* Effect.serviceOption(PaymentsProvider);

  return Effect.fn("Paykit.Checkout.start")(function* (input: CheckoutInput) {
    const tier = tierOf(catalog, input.tier);
    const allowances = allowancesOf(catalog, input.tier);
    if (tier === null || allowances === null) {
      return yield* new TierNotInCatalog({ tier: input.tier });
    }

    if (tier.price === undefined) {
      yield* subscription.send(
        Subscription.ref(input.account),
        new SubscribeCommand({
          tier: tier.id,
          allowances,
          ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
        }),
      );
      return { activated: true } as const satisfies CheckoutResult;
    }

    if (Option.isNone(payments)) {
      return yield* new ProviderCapabilityMissing({ provider: "none", op: "createCheckout" });
    }

    const service = Option.getOrThrow(payments);
    const purchase = yield* purchasePath(
      service,
      Option.getOrNull(provider),
      input.account,
      tier.id,
      tier.price.amount,
      tier.price.currency,
    );
    const reference = "url" in purchase ? purchase.url : purchase.invoiceId;
    yield* subscription.send(
      Subscription.ref(input.account),
      new AttachProviderRef({
        provider: Option.match(provider, {
          onNone: () => "provider",
          onSome: (found) => found.name,
        }),
        refs: { checkout: reference },
      }),
      { commandId: `checkout:${input.account}:${tier.id}:${reference}` },
    );
    return purchase;
  });
});

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

/** Complete a checkout from the provider's `checkout_completed` webhook. */
export const completeCheckout = (event: Omit<WebhookEvent, "kind">) =>
  handleWebhook({ ...event, kind: "checkout_completed" });
