import {
  PaymentDeclined,
  PaymentsPolar,
  ProviderCapabilityMissing,
  type PolarBindings,
  type PolarTier,
  type Provider,
  type Price,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Where a tier lives in Polar, and the price the catalog states. */
export type { PolarTier };

/** Which Polar the token belongs to. Sandbox products are not production's. */
export type PolarServer = "production" | "sandbox";

/**
 * The Polar calls this package makes, as an interface so a test can stand in.
 * The error channel is the vendor's own, as a parameter rather than `unknown`:
 * `polarBindings` maps whatever Polar raises into a `PaymentDeclined`, so
 * paykit's failure channel stays typed.
 */
export interface PolarClient<VendorError = never> {
  /** Create a checkout session for a product, for one customer. */
  readonly createCheckoutSession: (request: {
    readonly productId: string;
    readonly customerExternalId: string;
    readonly successUrl: string;
    readonly returnUrl: string;
  }) => Effect.Effect<{ readonly url: string }, VendorError>;
  /** A customer session, which is Polar's way into the customer portal. */
  readonly createCustomerSession: (request: {
    readonly customerExternalId: string;
  }) => Effect.Effect<{ readonly url: string }, VendorError>;
  /** Refund a Polar order. */
  readonly createRefund: (request: {
    readonly orderId: string;
    readonly amount: number;
  }) => Effect.Effect<unknown, VendorError>;
}

/** What `Polar()` needs to stand up a merchant of record. */
export interface PolarProps<VendorError = never> {
  /** The Polar access token. Redacted, because it is a secret. */
  readonly accessToken: string;
  /** Which Polar this token belongs to. Defaults to `production`. */
  readonly server?: PolarServer;
  /** The app's origin: checkout returns here. */
  readonly origin: string;
  /** Tier → Polar product, and the price the catalog already states. */
  readonly tiers?: Readonly<Record<string, PolarTier>>;
  /** Where a completed checkout returns to. Defaults to `/welcome`. */
  readonly successPath?: string;
  /** Where the portal returns to. Defaults to `/billing`. */
  readonly billingPath?: string;
  /**
   * The Polar calls, for a test or an embedding. Omitted in a deployment: the
   * distilled client is built from `accessToken` and `server`.
   */
  readonly client?: PolarClient<VendorError>;
}

const declined = (op: string, cause: unknown): PaymentDeclined =>
  new PaymentDeclined({
    provider: "polar",
    code: "polar_error",
    message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
  });

/** Map the Polar client onto the `Payments` port's shape. */
export const polarBindings = <VendorError>(
  client: PolarClient<VendorError>,
  where: { readonly origin: string; readonly successPath?: string; readonly billingPath?: string },
): PolarBindings => {
  const success = `${where.origin}${where.successPath ?? "/welcome"}`;
  const billing = `${where.origin}${where.billingPath ?? "/billing"}`;
  return {
    createCheckoutSession: ({ account, productId }) =>
      client
        .createCheckoutSession({
          productId,
          customerExternalId: account,
          successUrl: success,
          returnUrl: billing,
        })
        .pipe(
          Effect.mapError((cause) => declined("createCheckoutSession", cause)),
          Effect.map((session) => ({ url: session.url })),
        ),
    createCustomerSession: ({ account }) =>
      client.createCustomerSession({ customerExternalId: account }).pipe(
        Effect.mapError((cause) => declined("createCustomerSession", cause)),
        Effect.map((session) => ({ url: session.url })),
      ),
    createRefund: ({ chargeId, amount }) =>
      client.createRefund({ orderId: chargeId, amount }).pipe(
        Effect.mapError((cause) => declined("createRefund", cause)),
        Effect.map(() => ({})),
      ),
  };
};

/**
 * Polar as a merchant of record, ready for `Paykit.Stack`.
 *
 * One call, no bindings to wire: `Polar()` returns the `Provider` the catalog
 * needs, with the tier → product mapping and the price the catalog states, so
 * `Stack` can refuse a mapping that disagrees at deploy time.
 *
 * It owns tax, receipts and payments; paykit keeps the entitlement. Polar's
 * benefits are written as a consequence of a tier change and never read back —
 * `check()` answers from paykit's own read model.
 *
 * Polar is the one vendor with no Alchemy package, which is why paykit publishes
 * this one. It is paykit-shaped on purpose: a general provider would need its
 * own users and release train to justify the same maintenance.
 *
 * ### Selling a product with Polar
 * **Example:** A merchant of record behind the catalog
 * ```typescript
 * const polar = Polar({
 *   accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
 *   origin: "https://app.example.com",
 *   tiers: { pro: { price: proPrice, productId: "prod_123" } },
 * });
 *
 * yield* Paykit.Stack("Billing", { providers: [polar], catalog });
 * ```
 *
 * @primitive
 */
export const Polar = <VendorError = never>(
  props: PolarProps<VendorError>,
): Provider<"merchant_of_record"> => {
  if (props.client === undefined) {
    // A real deployment needs the distilled client, which is not wired yet. Fail
    // loudly at construction rather than start a checkout that cannot complete.
    throw new ProviderCapabilityMissing({
      provider: "polar",
      op: "createCheckoutSession",
    }) as unknown as Error;
  }
  return PaymentsPolar({
    bindings: polarBindings(props.client, props),
    ...(props.tiers === undefined ? {} : { tiers: props.tiers }),
  });
};

/** The price a tier is sold at, or `null` when Polar has no mapping for it. */
export const polarPriceOf = (props: Pick<PolarProps, "tiers">, tier: string): Price | null =>
  props.tiers?.[tier]?.price ?? null;

/** A layer that provides nothing; kept so `Polar` composes with `Layer.mergeAll`. */
export const polarLayer = Layer.empty as Layer.Layer<never>;
