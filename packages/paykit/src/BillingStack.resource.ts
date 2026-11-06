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

export const BillingStackRecord = Schema.Struct({
  catalog: Catalog,
  providers: Schema.optionalKey(Schema.Array(ProviderDescriptor)),
  store: Schema.optionalKey(BillingStore),
});
export type BillingStackRecord = typeof BillingStackRecord.Type;

/**
 * The shape of what a stack records. Bump it whenever `BillingStackAttrs`
 * changes.
 *
 * A read accepts every older shape: the next reconcile rewrites the record in
 * the current one, which is how Alchemy upgrades resource state in place. A
 * read of a *newer* shape is a typed refusal, because an older build must
 * never move state it does not understand back to an older layout.
 *
 * State written before the field existed has no `version` and is version `0`.
 */
export const BILLING_STACK_VERSION = 1;

/** A stack's state was written by a newer shape this build cannot read. */
export class BillingStackStateTooNew extends Schema.TaggedError<BillingStackStateTooNew>()(
  "BillingStackStateTooNew",
  {
    /** The version found in state; `0` when the record predates the field. */
    found: Schema.Int,
    /** The newest shape this build knows. */
    expected: Schema.Int,
  },
) {}

/** The shape version recorded in state, or `0` for state from before the field. */
export const billingStackVersionOf = (output: { readonly version?: number } | undefined): number =>
  output?.version ?? 0;

export const BillingStackAttrs = Schema.Struct({
  /** Absent on state written before the field existed; `read` treats that as 0. */
  version: Schema.optionalKey(Schema.Int),
  catalog: Catalog,
  tiers: Schema.Array(Schema.String),
  providers: Schema.Array(ProviderDescriptor),
  store: BillingStore,
});
export type BillingStackAttrs = typeof BillingStackAttrs.Type;

export type BillingStackShape = Resource<
  "Paykit.BillingStack",
  BillingStackRecord,
  BillingStackAttrs
>;

/**
 * The deploy-time billing stack. It validates the catalog and every provider
 * mapping and records the result in state; the event log is application data,
 * so the default removal policy is `retain`. Removing the resource never
 * cancels, refunds or deletes a provider's state.
 */
export const BillingStack = Resource<BillingStackShape>("Paykit.BillingStack", {
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
  props: BillingStackRecord | undefined,
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
 * read with no state is a resource that has not been created yet — `undefined`,
 * so the engine creates it. State from an older shape is returned as it is:
 * the reconcile that follows rewrites it, so an upgrade does not need its
 * state thrown away. A read of a newer shape is a typed refusal, because an
 * older build would otherwise move that state back to a layout it does not
 * understand.
 */
export const readBillingStack = (
  output: BillingStackAttrs | undefined,
): Effect.Effect<BillingStackAttrs | undefined, BillingStackStateTooNew> =>
  output === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        // Read off the record rather than the type: state written before the
        // field existed still has to be judged, not trusted.
        const found = billingStackVersionOf(output);
        if (found > BILLING_STACK_VERSION) {
          return yield* new BillingStackStateTooNew({
            found,
            expected: BILLING_STACK_VERSION,
          });
        }
        return output;
      });

/**
 * Force an update when the recorded shape is older than this build. A deploy
 * whose props did not change is otherwise a no-op, so the next reconcile would
 * never rewrite the record in the current shape.
 *
 * Pure, so the version policy is testable without building a provider Layer.
 */
export const diffBillingStack = (
  output: BillingStackAttrs | undefined,
): { readonly action: "update" } | undefined =>
  output !== undefined && billingStackVersionOf(output) < BILLING_STACK_VERSION
    ? { action: "update" }
    : undefined;

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
    diff: ({ output }) => Effect.succeed(diffBillingStack(output)),
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
