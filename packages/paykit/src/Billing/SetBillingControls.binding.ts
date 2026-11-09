import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { pricedInCatalog, type Catalog } from "../Catalog.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import type { BillingControls } from "../Customer.ts";
import {
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
  type ControlFeature,
} from "../Subscription/SetBillingControls.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** The controls to write. The bound account is not here. */
export interface SetBillingControlsRequest {
  /** The whole object, not a patch: the last write is the state. */
  readonly billingControls?: BillingControls;
}

/** What the write left in force. */
export interface SetBillingControlsResult {
  readonly billingControls?: BillingControls;
}

/**
 * The catalog facts a controls object names, keyed by feature id. A feature the
 * catalog does not declare is left out, so `decide` answers `ControlsFeatureUnknown`
 * rather than a binding inventing a fact. `priced` is "some plan bills it
 * postpaid", which is what a spend limit needs.
 */
export const controlFeaturesOf = (
  catalog: Catalog,
  billingControls: BillingControls | undefined,
): Record<string, ControlFeature> => {
  const ids = new Set([
    ...(billingControls?.spendLimits ?? []).map((limit) => limit.featureId),
    ...(billingControls?.usageAlerts ?? []).map((alert) => alert.featureId),
  ]);

  const entries: Array<readonly [string, ControlFeature]> = [];

  for (const featureId of ids) {
    const priced = pricedInCatalog(catalog, featureId);

    if (priced !== null) entries.push([featureId, { priced }]);
  }

  return Object.fromEntries(entries);
};

const refusals = [
  ControlsFeatureUnknown,
  ControlsFeatureNotPriced,
  ControlsDuplicate,
  CatalogMismatch,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a controls write can answer. */
export type SetBillingControlsRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isSetBillingControlsRefusal = oneOf<SetBillingControlsRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toSetBillingControlsError = toBindingError(
  "Paykit.SetBillingControls",
  isSetBillingControlsRefusal,
);

/** Everything this binding can answer. */
export type SetBillingControlsError = BindingError<SetBillingControlsRefusal>;

/** The verb of a bound `SetBillingControls`. */
export type SetBillingControlsVerb = (
  request: SetBillingControlsRequest,
) => Effect.Effect<SetBillingControlsResult, SetBillingControlsError>;

/**
 * Replace a customer's billing controls: its auto top-up line, its spend
 * ceilings and its usage alerts (ADR 0038). It works before a plan exists, so a
 * customer can state a refill line or a limit before it buys anything; an equal
 * object records nothing.
 *
 * The binding builds the catalog facts the command carries from the deployment's
 * own catalog, so the caller states controls and never catalog data.
 *
 * ### Lowering a ceiling
 * **Example:** Cap a customer's monthly API spend
 * ```typescript
 * const controls = yield* Paykit.SetBillingControls(account);
 * yield* controls({
 *   billingControls: { spendLimits: [{ featureId: "requests", amount: 5_000 }] },
 * });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.SetBillingControls
 */
export interface SetBillingControls extends Binding.Service<
  SetBillingControls,
  "Paykit.SetBillingControls",
  (account: string) => Effect.Effect<SetBillingControlsVerb>
> {}

export const SetBillingControls = Binding.Service<SetBillingControls>("Paykit.SetBillingControls");
