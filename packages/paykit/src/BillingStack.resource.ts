import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { catalog, Catalog, type CatalogError } from "./Catalog.ts";
import {
  CatalogPriceMismatch,
  NoPurchasePath,
  ProviderDuplicate,
  ProviderDescriptor,
  validateProviderMappings,
} from "./Stack.ts";

/** The store kind a stack records; the connection URL is a runtime binding. */
export const BillingStore = Schema.Union([
  Schema.TaggedStruct("MemoryStore", {}),
  Schema.TaggedStruct("PostgresStore", { schema: Schema.String }),
  Schema.TaggedStruct("SqliteStore", { schema: Schema.String }),
]);
export type BillingStore = typeof BillingStore.Type;

export const BillingStackProps = Schema.Struct({
  catalog: Catalog,
  providers: Schema.optionalKey(Schema.Array(ProviderDescriptor)),
  store: Schema.optionalKey(BillingStore),
});
export type BillingStackProps = typeof BillingStackProps.Type;

/**
 * The shape of what a stack records. Bump it whenever `BillingStackAttrs`
 * changes in a way old state cannot read, and `read` refuses a version it does
 * not know instead of handing back a record it silently half-understands.
 *
 * State written before the field existed has no `version` and is version `0`.
 */
export const BILLING_STACK_VERSION = 1;

/** A stack's state was written by a shape this version cannot read. */
export class BillingStackStateOutdated extends Schema.TaggedError<BillingStackStateOutdated>()(
  "BillingStackStateOutdated",
  {
    /** The version found in state; `0` when the record predates the field. */
    found: Schema.Int,
    expected: Schema.Int,
  },
) {}

export const BillingStackAttrs = Schema.Struct({
  /** Absent on state written before the field existed; `read` treats that as 0. */
  version: Schema.optionalKey(Schema.Int),
  catalog: Catalog,
  tiers: Schema.Array(Schema.String),
  providers: Schema.Array(ProviderDescriptor),
  store: BillingStore,
});
export type BillingStackAttrs = typeof BillingStackAttrs.Type;

export type BillingStackResource = Resource<
  "Paykit.BillingStack",
  BillingStackProps,
  BillingStackAttrs
>;

/**
 * The deploy-time billing stack. It validates the catalog and every provider
 * mapping and records the result in state; the event log is application data,
 * so the default removal policy is `retain`. Removing the resource never
 * cancels, refunds or deletes a provider's state.
 */
export const BillingStack = Resource<BillingStackResource>("Paykit.BillingStack", {
  defaultRemovalPolicy: "retain",
});

/**
 * What a reconcile records: the catalog re-validated, the tier ids a console
 * can list, and the store kind. Pure in, pure out, so a deploy that changes
 * nothing produces the same attributes byte for byte and Alchemy diffs it to
 * a no-op.
 *
 * A catalog that does not validate fails the deploy with its tagged error
 * rather than recording half a stack.
 */
export const reconcileBillingStack = (
  props: BillingStackProps | undefined,
): Effect.Effect<
  BillingStackAttrs,
  CatalogError | CatalogPriceMismatch | NoPurchasePath | ProviderDuplicate
> =>
  Effect.gen(function* () {
    // A reconcile without props is a delete, and delete never reaches here.
    if (props === undefined) return yield* Effect.die("BillingStack reconciles with props");
    const parsed = yield* catalog(props.catalog);
    const providers = props.providers ?? [];
    const invalid = validateProviderMappings(parsed, providers);
    if (invalid !== null) return yield* invalid;
    return {
      version: BILLING_STACK_VERSION,
      catalog: parsed,
      tiers: parsed.tiers.map((tier) => tier.id),
      providers,
      store: props.store ?? { _tag: "MemoryStore" as const },
    };
  });

/**
 * What a read returns: the attributes already in state, never a re-derive. A
 * read with no state is a resource that has not been created yet, and a read of
 * a version this package cannot interpret is a typed refusal — the alternative
 * is a run that diffs against attributes it only half understands.
 */
export const readBillingStack = (
  output: BillingStackAttrs | undefined,
): Effect.Effect<BillingStackAttrs, BillingStackStateOutdated> =>
  output === undefined
    ? Effect.die("BillingStack is read before it was reconciled")
    : Effect.gen(function* () {
        // Read off the record rather than the type: state written before the
        // field existed still has to be judged, not trusted.
        const found = (output as { readonly version?: number }).version ?? 0;
        if (found !== BILLING_STACK_VERSION) {
          return yield* new BillingStackStateOutdated({
            found,
            expected: BILLING_STACK_VERSION,
          });
        }
        return output;
      });

/**
 * The Alchemy provider for `BillingStack`. Reconcile validates; read trusts
 * state; delete touches nothing, because the event log is application data and
 * cancelling a live subscription from a destroy is a support incident.
 *
 * `nuke: { singleton: true }` says exactly that: a stack is always-present
 * configuration with no cloud object, so `alchemy unsafe nuke` must not report
 * it as "deleted but still there". `list` is left out on purpose — Alchemy's
 * default for a provider with no enumeration API is `[]`.
 */
export const BillingStackProvider = () =>
  Provider.succeed(BillingStack, {
    // Alchemy persists this beside the state, so the engine can tell two
    // generations of the same resource apart. It moves with the attrs.
    version: BILLING_STACK_VERSION,
    nuke: { singleton: true },
    reconcile: ({ news }) => reconcileBillingStack(news),
    read: ({ output }) => readBillingStack(output),
    delete: () => Effect.void,
  });

/**
 * Every Alchemy provider this package owns, as one Layer, so a stack declares
 * `Paykit.providers()` beside `Cloudflare.providers()`.
 *
 * @layer
 */
export const providers = () => Layer.mergeAll(BillingStackProvider());
