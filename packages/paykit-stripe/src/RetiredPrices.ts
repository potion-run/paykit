import {
  GetPrices,
  UpdatePrice,
  type GetPricesResponse,
  type StripeOpContext,
  type StripeOpError,
} from "@distilled.cloud/stripe/stripe";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { priceDeclarations, retiredPrices, type FoundPrice, type TierPrice } from "./Prices.ts";

/**
 * What a sweep archived: the Stripe price ids it deactivated, in the order the
 * account listed them.
 */
export interface ArchivedPrices {
  /** The prices this run turned off. Empty when the catalog already matches. */
  readonly archived: ReadonlyArray<string>;
}

/** Every active price the account holds, page by page. */
const activePrices = (
  page: (
    startingAfter: string | undefined,
  ) => Effect.Effect<GetPricesResponse, StripeOpError, StripeOpContext>,
): Effect.Effect<ReadonlyArray<FoundPrice>, StripeOpError, StripeOpContext> => {
  const collect = (
    startingAfter: string | undefined,
    found: ReadonlyArray<FoundPrice>,
  ): Effect.Effect<ReadonlyArray<FoundPrice>, StripeOpError, StripeOpContext> =>
    Effect.flatMap(page(startingAfter), (result) => {
      const rows = result.data.flatMap((price) =>
        price.id === undefined
          ? []
          : [
              {
                id: price.id,
                lookupKey: price.lookup_key ?? null,
                active: price.active === true,
              },
            ],
      );

      const next = result.data[result.data.length - 1]?.id;
      const seen = [...found, ...rows];

      return result.has_more && next !== undefined ? collect(next, seen) : Effect.succeed(seen);
    });

  return collect(undefined, []);
};

/**
 * Turn off the Stripe prices a stage still has active that its catalog no
 * longer declares.
 *
 * Every price `StripePrices` creates is declared with `RemovalPolicy.retain`, so
 * a tier that leaves the catalog keeps its price — a bill already sent has to
 * stay reproducible. Retain does not stop the price being sold, though: a
 * detached Stripe price is still `active`, so a retired tier keeps its checkout
 * entry point. This is the write that closes that gap, and it never deletes:
 * `active: false` keeps the object, the invoices that reference it, and the
 * subscription items priced by it.
 *
 * What to archive is decided by `retiredPrices`, which is pure and tested
 * against a fixture. This function only lists, asks, and writes.
 *
 * ### Why not a resource
 * There is nothing here to own. The prices a stack sells are `Stripe.Price`
 * resources; the ones this sweeps are precisely the ones no stack owns any more,
 * so a resource would have to model "the set of objects nobody owns" — a value
 * Alchemy cannot diff, which would re-run every deploy and report a changing
 * answer as drift. The sweep is idempotent by construction instead: it archives
 * what is active and undeclared, and a second run finds nothing.
 *
 * ### Archiving retired prices
 * **Example:** A deploy that turns off what the catalog dropped
 * ```typescript
 * const sold = yield* StripePrices("Prices", { tiers });
 * const { archived } = yield* RetiredPrices("Retired", { tiers });
 * ```
 *
 * @primitive
 * @product Stripe
 */
export const RetiredPrices = Effect.fn("Stripe.RetiredPrices")(function* (
  _id: string,
  props: { readonly tiers: Readonly<Record<string, TierPrice>> },
) {
  const stack = yield* Stack;
  const declarations = priceDeclarations(props.tiers, stack.stage);

  const found = yield* activePrices((startingAfter) =>
    GetPrices({
      active: true,
      limit: 100,
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    }),
  );

  const retired = retiredPrices(declarations, found, stack.stage);
  yield* Effect.forEach(retired, (price) => UpdatePrice({ price: price.id, active: false }), {
    concurrency: 1,
    discard: true,
  });

  return { archived: retired.map((price) => price.id) } satisfies ArchivedPrices;
});
