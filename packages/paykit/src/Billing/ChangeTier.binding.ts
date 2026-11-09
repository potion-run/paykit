import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Allowance } from "../Allowance.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import type { Proration } from "../Proration.ts";
import {
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
} from "../Subscription/ChangeTier.command.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { ProrationMismatch } from "../Subscription/ProrationMismatch.rejection.ts";
import { StandingEnded } from "../Subscription/StandingEnded.rejection.ts";
import type { Price } from "../Tier.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * Move a standing to another tier. The catalog is the layer's, so a caller names
 * the tier and nothing else: `price`, `allowances`, `credits` and the rates are
 * joined here, and the proration is computed from the standing — which is why
 * this binding needs the model in process and is not served over an Api today.
 */
export interface ChangeTierRequest {
  readonly tier: string;
  /**
   * The plan items a custom plan is moved to with, when they differ from the
   * catalog's defaults (ADR 0041). Omitted means the plan's `grants`.
   */
  readonly grants?: ReadonlyArray<Allowance>;
  /**
   * The price a custom plan is moved to at, when it was negotiated (ADR 0042
   * §3). Omitted means the catalog's price, and the proration is computed from
   * whichever price is stated.
   */
  readonly price?: Price;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** What the change moved. A positive `due` is money `ChargeProration` collects. */
export interface ChangeTierResult {
  readonly tier: string;
  readonly proration: Proration | null;
}

const refusals = [
  PlanNotInCatalog,
  NotSubscribed,
  StandingEnded,
  CurrencyMismatch,
  DowngradeBelowUsage,
  DowngradeBelowSpend,
  DowngradeBelowCeiling,
  ProrationMismatch,
  CatalogMismatch,
  Unauthenticated,
  Forbidden,
] as const;

/** Every way a tier change can be refused, as one list. */
export type ChangeTierRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is `ChangeTier` refusing the request. */
export const isChangeTierRefusal = oneOf<ChangeTierRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toChangeTierError = toBindingError("Paykit.ChangeTier", isChangeTierRefusal);

/** Everything this binding can answer. */
export type ChangeTierError = BindingError<ChangeTierRefusal>;

/** The verb of a bound `ChangeTier`. */
export type ChangeTierVerb = (
  request: ChangeTierRequest,
) => Effect.Effect<ChangeTierResult, ChangeTierError>;

/**
 * Change the tier a standing is on.
 *
 * `Preview` shows the same proration before anyone agrees to it; `ChargeProration`
 * is what collects a positive one. A downgrade below what the period already
 * used or billed is refused, and so is a move that would land above a ceiling the
 * period has already passed.
 *
 * ### Moving to a bigger plan
 * **Example:** Change tier, then collect what it moved
 * ```typescript
 * const changeTier = yield* Paykit.ChangeTier(account);
 * const { proration } = yield* changeTier({ tier: "scale", dedupeKey: requestId });
 * if (proration !== null && proration.due > 0) yield* chargeProration();
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.ChangeTier
 */
export interface ChangeTier extends Binding.Service<
  ChangeTier,
  "Paykit.ChangeTier",
  (account: string) => Effect.Effect<ChangeTierVerb>
> {}

export const ChangeTier = Binding.Service<ChangeTier>("Paykit.ChangeTier");
