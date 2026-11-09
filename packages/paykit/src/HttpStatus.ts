/**
 * The HTTP status a paykit refusal deserves.
 *
 * A refusal is not a server fault: an account that names a tier the catalog
 * does not sell sent a bad request, a caller with no session is unauthorised,
 * and a provider that cannot do what the deployment asked is not implemented.
 * The default is `500`, so a tag this map does not know still fails closed.
 *
 * It takes any tagged value — `{ readonly _tag?: string }` — so it accepts the
 * package's refusals, a provider's `WebhookError`, and a deployment's own
 * error without importing the union.
 *
 * ### Answering a refusal
 * **Example:** A route that maps a failed purchase to a status
 * ```typescript
 * const purchase = yield* Effect.result(subscribe({ tier }));
 * if (Result.isFailure(purchase)) {
 *   return HttpServerResponse.jsonUnsafe(
 *     { error: purchase.failure._tag },
 *     { status: Paykit.httpStatus(purchase.failure) },
 *   );
 * }
 * ```
 *
 * @primitive
 */
export const httpStatus = (error: { readonly _tag?: string }): number => {
  switch (error._tag) {
    // The request names something the deploy does not have.
    case "PlanNotInCatalog":
    case "PlanPhaseNotFuture":
    case "PlanPhaseNamesAddOn":
    case "WebhookInvalid":
    case "PendingActivationMissing":
    case "PendingActivationStale":
    case "CatalogInvalid":
    case "CatalogMismatch":
    case "NotSubscribed":
    case "StandingEnded":
    case "PlanOperationUnsupported":
    case "ControlsFeatureUnknown":
    case "ControlsFeatureNotPriced":
    case "ControlsDuplicate":
      return 400;
    // The caller is not signed in, or the delivery is not signed by the vendor.
    case "Unauthenticated":
    case "WebhookSignatureInvalid":
      return 401;
    // The provider refused the money.
    case "PaymentDeclined":
      return 402;
    // The delivery could describe more than one purchase and names none.
    case "PendingActivationAmbiguous":
      return 409;
    // The caller is signed in and may not do this, or the request came from an
    // origin the deployment does not serve.
    case "Forbidden":
    case "CrossOrigin":
      return 403;
    // The command conflicts with the state it names: an older plan generation
    // than the standing already holds (ADR 0047 §5).
    case "PlanVersionStale":
      return 409;
    // The provider does not implement the capability the deployment asked for.
    case "ProviderCapabilityMissing":
      return 501;
    default:
      return 500;
  }
};
