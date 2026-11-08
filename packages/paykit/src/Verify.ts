import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Catalog, tierOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import { PaymentCapability, PaymentsProvider, PaymentsRouter, providerFor } from "./Payments.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "./Subscription/Subscription.state.ts";

/**
 * A priced tier is in force but the account carries no vendor reference for
 * the provider, so the money path never completed. The usual cause is a
 * checkout that was started and never finished.
 */
export class MissingProviderRef extends Schema.TaggedError<MissingProviderRef>()(
  "MissingProviderRef",
  {
    account: Schema.String,
    tier: Schema.String,
    provider: Schema.String,
  },
) {}

/**
 * The account carries a vendor reference for a provider but has no standing
 * for it to belong to: a vendor id outlived the subscription it described.
 */
export class OrphanProviderRef extends Schema.TaggedError<OrphanProviderRef>()(
  "OrphanProviderRef",
  {
    account: Schema.String,
    provider: Schema.String,
  },
) {}

/**
 * The catalog sells the tier the account is on, but no configured provider
 * declares a purchase path, so the account could not be renewed.
 */
export class TierHasNoPurchasePath extends Schema.TaggedError<TierHasNoPurchasePath>()(
  "TierHasNoPurchasePath",
  {
    account: Schema.String,
    tier: Schema.String,
    provider: Schema.String,
  },
) {}

/** Every way an account's standing disagrees with the deploy. */
export const VerifyMismatch = Schema.Union([
  MissingProviderRef,
  OrphanProviderRef,
  TierHasNoPurchasePath,
]);

export type VerifyMismatch = typeof VerifyMismatch.Type;

/** What `verify` judges an account against: the catalog and the provider it runs on. */
export interface VerifyOptions {
  readonly catalog: Catalog;
  /** The provider's name and declared capabilities, or `null` for a memory stack. */
  readonly provider: {
    readonly name: string;
    readonly capabilities: ReadonlySet<PaymentCapability>;
  } | null;
}

const sellsAnything = (provider: VerifyOptions["provider"]): boolean =>
  provider === null ||
  provider.capabilities.has("checkout") ||
  provider.capabilities.has("invoice");

/**
 * Judge one account's state against the deploy: a priced tier with no vendor
 * reference, a vendor reference with no standing, a sold tier no provider can
 * charge. Pure, so `doctor` and a test can call it without a store.
 *
 * This is the account-level drift check. It catches a checkout that was
 * started and abandoned, which is the drift a deploy can still fix. Vendor
 * state that disagrees with ours needs a provider read, which is a future
 * `Payments` operation rather than something this function can see.
 */
export const verifyState = (
  account: string,
  state: SubscriptionState,
  options: VerifyOptions,
): ReadonlyArray<VerifyMismatch> => {
  const { catalog, provider } = options;
  const providerName = provider?.name ?? "memory";
  const refs = state.refs;
  const carriesRef = Object.keys(refs).length > 0;

  if (state._tag !== "Subscribed") {
    return carriesRef ? [new OrphanProviderRef({ account, provider: Object.keys(refs)[0]! })] : [];
  }

  const tier = tierOf(catalog, state.tier);

  if (tier === null) return [];

  if (tier.price !== undefined) {
    if (provider !== null && refs[provider.name] === undefined) {
      return [new MissingProviderRef({ account, tier: tier.id, provider: providerName })];
    }

    if (!sellsAnything(provider)) {
      return [new TierHasNoPurchasePath({ account, tier: tier.id, provider: providerName })];
    }
  }

  return [];
};

/**
 * Check one account's standing against the catalog and the configured
 * provider. A clean account returns `[]`; every finding is a typed mismatch
 * naming the account, the tier and the provider, so a console can link
 * straight to it.
 *
 * `verifyState` is the same check without a store, for `doctor` and tests.
 *
 * ### Finding accounts a checkout abandoned
 * **Example:** Verify an account after a support report
 * ```typescript
 * const mismatches = yield* Paykit.Verify({ account });
 * if (mismatches.some((m) => m._tag === "MissingProviderRef")) {
 *   yield* reopenCheckout({ account });
 * }
 * ```
 *
 * @primitive
 */
export const Verify = Effect.fn("Paykit.Verify")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const router = yield* Effect.serviceOption(PaymentsRouter);

  return Effect.fn("Paykit.Verify.account")(function* (input: { readonly account: string }) {
    const state = yield* subscription.state(Subscription.ref(input.account));

    // With a router, the account's own provider is the one that could sell its
    // tier; without one, the single layer in context is.
    const routed = Option.match(router, {
      onNone: () => null,
      onSome: (set) => providerFor(set, state.refs),
    });

    const provider = routed ?? Option.getOrNull(yield* Effect.serviceOption(PaymentsProvider));

    return verifyState(input.account, state, { catalog, provider });
  });
});
