import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { type PaymentError, PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** What a portal answers: a hosted URL. */
export interface PortalResult {
  readonly url: string;
}

const portalRefusals = [
  ProviderCapabilityMissing,
  PaymentDeclined,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a portal can answer. */
export type PortalRefusal = InstanceType<(typeof portalRefusals)[number]>;

export type PortalError = BindingError<PortalRefusal>;

/** Whether a failure is the provider refusing to open a portal. */
export const isPortalRefusal = oneOf<PortalRefusal>(portalRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toPortalError = toBindingError("Paykit.Portal", isPortalRefusal);

/** The verb of a bound `Portal`. The account is the bind, so it takes nothing. */
export type PortalVerb = () => Effect.Effect<PortalResult, PortalError>;

/** What charging a proration did. */
export interface ChargeProrationResult {
  /** `charged` when an invoice was opened; `nothing` when there was nothing to bill. */
  readonly outcome: "charged" | "nothing";
  readonly invoiceId?: string;
  /** Minor units. Present when something was charged. */
  readonly amount?: number;
  readonly currency?: string;
}

const chargeRefusals = [ProviderCapabilityMissing, PaymentDeclined] as const;

/**
 * Every refusal collecting a proration can answer. Nothing to collect is not
 * one of them: the verb answers `{ outcome: "nothing" }`, so a caller does not
 * write a catch for the common case.
 */
export type ChargeProrationRefusal = InstanceType<(typeof chargeRefusals)[number]>;

export type ChargeProrationError = BindingError<ChargeProrationRefusal | PaymentError>;

/** Whether a failure is the account having nothing to collect. */
export const isChargeProrationRefusal = oneOf<ChargeProrationRefusal>(chargeRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toChargeProrationError = toBindingError(
  "Paykit.ChargeProration",
  isChargeProrationRefusal,
);

/** The verb of a bound `ChargeProration`. The account is the bind, so it takes nothing. */
export type ChargeProrationVerb = () => Effect.Effect<ChargeProrationResult, ChargeProrationError>;

/**
 * Open the provider's customer portal, when it has one. The portal belongs to
 * the provider the account already pays through, so the standing picks it and
 * only that provider's layer is provided for the call.
 *
 * ### Sending a customer to their invoices
 * **Example:** Open the portal
 * ```typescript
 * const portal = yield* Paykit.Portal(account);
 * const { url } = yield* portal();
 * return Response.redirect(url);
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.Portal
 */
export interface Portal extends Binding.Service<
  Portal,
  "Paykit.Portal",
  (account: string) => Effect.Effect<PortalVerb>
> {}

export const Portal = Binding.Service<Portal>("Paykit.Portal");

/**
 * Charge the money a mid-cycle tier change moved. `ChangeTier` records the
 * proration and `Preview` shows it; neither collects it, because `decide` is
 * pure and only an effect can ask a provider for an invoice.
 *
 * Three rules: only a positive `due` is charged (a downgrade's credit is applied
 * by the next period), it happens once (the invoice id is recorded, so a second
 * call answers `nothing`), and the log carries the money — a `RecordProrationInvoice`
 * command, not a side effect.
 *
 * ### Collecting an upgrade
 * **Example:** Charge the difference after a tier change
 * ```typescript
 * const chargeProration = yield* Paykit.ChargeProration(account);
 * const charged = yield* chargeProration();
 * if (charged.outcome === "charged") notify(charged.invoiceId);
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.ChargeProration
 */
export interface ChargeProration extends Binding.Service<
  ChargeProration,
  "Paykit.ChargeProration",
  (account: string) => Effect.Effect<ChargeProrationVerb>
> {}

export const ChargeProration = Binding.Service<ChargeProration>("Paykit.ChargeProration");
