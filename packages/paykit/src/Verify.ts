import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Catalog, planOf } from "./Catalog.ts";
import { catalogMismatchOf } from "./CatalogGuard.ts";
import { CatalogService } from "./CatalogService.ts";
import { PaymentCapability, PaymentsProvider, PaymentsRouter, providerFor } from "./Payments.ts";
import { DEFAULT_PLAN_GROUP } from "./Subscription/PlanSet.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "./Subscription/Subscription.state.ts";
import { planIdOf, planRowsOf } from "./Subscription/Subscription.state.ts";

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

/**
 * A standing holds an older generation of a plan than the catalog sells. It is
 * not an error: a catalog deploy never rewrites what was sold, and the next
 * move is the migration (ADR 0047). It is drift a console shows so an operator
 * can decide when to move the account.
 */
export class PlanVersionOutdated extends Schema.TaggedError<PlanVersionOutdated>()(
  "PlanVersionOutdated",
  {
    account: Schema.String,
    tier: Schema.String,
    /** The generation the standing was sold at. */
    version: Schema.Int,
    /** The generation the catalog sells now. */
    catalogVersion: Schema.Int,
  },
) {}

/**
 * A standing holds a newer generation than the running catalog knows. The
 * deploy is behind the state it serves, so nothing may move the account until
 * the deploy catches up: recording an older generation over a newer one is the
 * one direction a version may never take.
 */
export class PlanVersionAhead extends Schema.TaggedError<PlanVersionAhead>()("PlanVersionAhead", {
  account: Schema.String,
  tier: Schema.String,
  /** The generation the standing was sold at. */
  version: Schema.Int,
  /** The newest generation this deploy knows. */
  catalogVersion: Schema.Int,
}) {}

/**
 * The catalog changed a fixed plan's terms without bumping its version. The
 * standing is valid, but it claims a generation the deploy no longer sells
 * under that number, so a replay and a fresh move would disagree about what
 * "pro v2" means. A custom plan is exempt: its bespoke terms are the deal, not
 * the catalog's.
 */
export class PlanVersionDrift extends Schema.TaggedError<PlanVersionDrift>()("PlanVersionDrift", {
  account: Schema.String,
  tier: Schema.String,
  version: Schema.Int,
  /** The first catalog field that disagreed, for an operator to find it. */
  field: Schema.String,
}) {}

/** Every way an account's standing disagrees with the deploy. */
export const VerifyMismatch = Schema.Union([
  MissingProviderRef,
  OrphanProviderRef,
  TierHasNoPurchasePath,
  PlanVersionOutdated,
  PlanVersionAhead,
  PlanVersionDrift,
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

  const sold = planIdOf(state);
  const tier = sold === "" ? null : planOf(catalog, sold);

  if (tier === null) return [];

  const mismatches: Array<VerifyMismatch> = [];

  if (tier.price !== undefined) {
    if (provider !== null && refs[provider.name] === undefined) {
      mismatches.push(new MissingProviderRef({ account, tier: tier.id, provider: providerName }));
    }

    if (!sellsAnything(provider)) {
      mismatches.push(
        new TierHasNoPurchasePath({ account, tier: tier.id, provider: providerName }),
      );
    }
  }

  // Every active plan carries the catalog generation it was sold at. An older
  // one is drift the operator can migrate; a newer one means this deploy is
  // serving state it cannot judge (ADR 0047).
  for (const row of planRowsOf(state)) {
    const sold = planOf(catalog, row.planId);

    // A plan the catalog removed leaves its standing alone: there is no
    // generation to compare it with, and deleting it would be the destruction
    // ADR 0003 refuses.
    if (sold === null) continue;

    const catalogVersion = sold.version ?? 1;

    if (row.version !== catalogVersion) {
      mismatches.push(
        row.version < catalogVersion
          ? new PlanVersionOutdated({
              account,
              tier: row.planId,
              version: row.version,
              catalogVersion,
            })
          : new PlanVersionAhead({
              account,
              tier: row.planId,
              version: row.version,
              catalogVersion,
            }),
      );

      continue;
    }

    // A fixed plan at the catalog's own generation must describe the catalog's
    // terms. A custom plan's bespoke set is the deal, so it is exempt.
    if (sold.custom === true) continue;

    const drift = catalogMismatchOf(catalog, {
      tier: row.planId,
      version: row.version,
      ...(row.group === DEFAULT_PLAN_GROUP ? {} : { group: row.group }),
      addOn: row.addOn,
      allowances: row.allowances,
      ...(row.price === undefined ? {} : { price: row.price }),
      credits: row.credits,
      creditsExpire: row.creditsExpire,
      ...(row.topUp === undefined ? {} : { topUp: row.topUp }),
      rates: row.rates,
    });

    if (drift !== null) {
      mismatches.push(
        new PlanVersionDrift({
          account,
          tier: row.planId,
          version: row.version,
          field: drift.field,
        }),
      );
    }
  }

  return mismatches;
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
