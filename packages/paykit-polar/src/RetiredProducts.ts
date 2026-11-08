import * as Polar from "@distilled.cloud/polar";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { priceDeclarations, retiredProducts, type FoundProduct, type TierPrice } from "./Prices.ts";
import { PAYKIT_TIER } from "./Product.ts";

/**
 * What a sweep archived: the Polar product ids it archived, in the order the
 * organization listed them.
 */
export interface ArchivedProducts {
  /** The products this run turned off. Empty when the catalog already matches. */
  readonly archived: ReadonlyArray<string>;
}

/** One page of Polar's product list, and whether it is the last. */
interface ProductPage {
  readonly items: ReadonlyArray<Polar.Product>;
  readonly last: boolean;
}

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The tier a product declares, or `null` when the metadata carries none. */
const tierOf = (product: Polar.Product): string | null => {
  const tier = product.metadata[PAYKIT_TIER];

  return typeof tier === "string" ? tier : null;
};

const found = (product: Polar.Product): FoundProduct => ({
  id: product.id,
  name: product.name,
  tier: tierOf(product),
  archived: product.is_archived,
});

/** Every product Polar still offers for sale, page by page. */
const activeProducts = <R>(
  page: (input: {
    readonly page: number;
    readonly limit: number;
    readonly is_archived: boolean;
  }) => Effect.Effect<ProductPage, Polar.PolarOpError, R>,
): Effect.Effect<ReadonlyArray<FoundProduct>, Polar.PolarOpError, R> => {
  const collect = (
    pageNumber: number,
    seen: ReadonlyArray<FoundProduct>,
  ): Effect.Effect<ReadonlyArray<FoundProduct>, Polar.PolarOpError, R> =>
    Effect.flatMap(
      page({ page: pageNumber, limit: LIST_PAGE_SIZE, is_archived: false }),
      (result) => {
        const rows = [...seen, ...result.items.map(found)];

        return result.last || result.items.length === 0 || pageNumber >= LIST_MAX_PAGES
          ? Effect.succeed(rows)
          : collect(pageNumber + 1, rows);
      },
    );

  return collect(1, []);
};

/**
 * Archive the Polar products a stage still sells that its catalog no longer
 * declares.
 *
 * Every product `PolarPrices` creates is declared with `RemovalPolicy.retain`,
 * so a tier that leaves the catalog keeps its product — a bill already sent has
 * to stay reproducible. Retain does not stop the product being bought, though: a
 * detached Polar product is still purchasable, so a retired tier keeps its
 * checkout entry point. This is the write that closes that gap, and it never
 * deletes: `is_archived` keeps the product, the orders that reference it, and
 * the subscriptions priced by it, and Polar still honors the benefits a live
 * subscription bought.
 *
 * What to archive is decided by `retiredProducts`, which is pure and tested
 * against a fixture. This function only lists, asks, and writes.
 *
 * ### Why not a resource
 * There is nothing here to own. The products a stack sells are `Polar.Product`
 * resources; the ones this sweeps are precisely the ones no stack owns any more,
 * so a resource would have to model "the set of objects nobody owns" — a value
 * Alchemy cannot diff, which would re-run every deploy and report a changing
 * answer as drift. The sweep is idempotent by construction instead: it archives
 * what is sellable and undeclared, and a second run finds nothing.
 *
 * ### Archiving retired products
 * **Example:** A deploy that turns off what the catalog dropped
 * ```typescript
 * const sold = yield* PolarPrices("Prices", { tiers });
 * const { archived } = yield* RetiredProducts("Retired", { tiers });
 * ```
 *
 * @primitive
 * @product Polar
 */
export const RetiredProducts = Effect.fn("Polar.RetiredProducts")(function* (
  _id: string,
  props: { readonly tiers: Readonly<Record<string, TierPrice>> },
) {
  const stack = yield* Stack;
  const declarations = priceDeclarations(props.tiers, stack.stage);

  const found = yield* activeProducts((input) =>
    Polar.productsList(input).pipe(
      Effect.map((listed) => ({
        items: listed.items,
        last: listed.pagination.max_page === undefined || input.page >= listed.pagination.max_page,
      })),
    ),
  );

  const retired = retiredProducts(declarations, found, stack.stage);
  yield* Effect.forEach(
    retired,
    (product) => Polar.productsUpdate({ id: product.id, is_archived: true }),
    { concurrency: 1, discard: true },
  );

  return { archived: retired.map((product) => product.id) } satisfies ArchivedProducts;
});
