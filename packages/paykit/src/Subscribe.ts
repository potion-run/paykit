import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { allowancesOf, tierOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import { Payments, ProviderCapabilityMissing } from "./Payments.ts";
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
 * Start a purchase. A priced tier goes through the provider's purchase path
 * and activates when its payment is recorded; a free tier activates now.
 */
export const Subscribe = Effect.fn("Paykit.Subscribe")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  const payments = yield* Effect.serviceOption(Payments);

  return Effect.fn("Paykit.Subscribe.start")(function* (input: SubscribeInput) {
    const tier = tierOf(catalog, input.tier);
    const allowances = allowancesOf(catalog, input.tier);
    if (tier === null || allowances === null) {
      return yield* new TierNotInCatalog({ tier: input.tier });
    }

    if (tier.price === undefined) {
      const receipt = yield* subscription.send(
        Subscription.ref(input.account),
        new SubscribeCommand({
          tier: tier.id,
          allowances,
          ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
        }),
      );
      yield* entitlements.query(Subscription.ref(input.account), { atLeast: receipt });
      return { activated: true };
    }

    if (Option.isNone(payments)) {
      return yield* new ProviderCapabilityMissing({ provider: "none", op: "createCheckout" });
    }

    const service = Option.getOrThrow(payments);
    return yield* service.createCheckout({ account: input.account, tier: tier.id }).pipe(
      Effect.catchTag("ProviderCapabilityMissing", () =>
        service.createInvoice({
          account: input.account,
          amount: tier.price!.amount,
          currency: tier.price!.currency,
        }),
      ),
    );
  });
});
