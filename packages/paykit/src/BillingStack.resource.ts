import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
  Schema.TaggedStruct("MySQLStore", {}),
  Schema.TaggedStruct("D1Store", {}),
  Schema.TaggedStruct("DurableObjectStore", {}),
]);

export type BillingStore = typeof BillingStore.Type;

export const BillingStackRecord = Schema.Struct({
  catalog: Catalog,
  providers: Schema.optionalKey(Schema.Array(ProviderDescriptor)),
  store: Schema.optionalKey(BillingStore),
});

export type BillingStackRecord = typeof BillingStackRecord.Type;

/**
 * The version of the shape `BillingStackAttrs` records. This is the first
 * version; the library has not published a state shape before it.
 *
 * Bump it by hand with every change `BillingStackAttrs` cannot read from an
 * older record, and add the step that carries the older record over to
 * `reconcileBillingStack`. A read, diff or reconcile accepts every older
 * version; the next reconcile rewrites the record in the current one. A record
 * from a *newer* version is a typed refusal, because an older build must never
 * move state it does not understand back to an older layout.
 */
export const BILLING_STACK_VERSION = 0;

/**
 * How a recorded shape version compares with the build's current version.
 * `update` is an older record the next reconcile rewrites; `too-new` is a
 * record this build must refuse.
 */
export type BillingStackVersionDecision = "current" | "update" | "too-new";

/**
 * The whole version policy as one pure function: older is an update, the
 * current version is a no-op, and newer is a refusal.
 */
export const billingStackVersionDecision = (
  current: number,
  recorded: number,
): BillingStackVersionDecision =>
  recorded > current ? "too-new" : recorded < current ? "update" : "current";

/** A stack's state was written by a newer shape this build cannot read. */
export class BillingStackVersionTooNew extends Schema.TaggedError<BillingStackVersionTooNew>()(
  "BillingStackVersionTooNew",
  {
    /** The fully-qualified name of the stack that recorded the state. */
    fqn: Schema.String,
    /** The version found in state. */
    deployed: Schema.Int,
    /** The newest shape this build knows. */
    current: Schema.Int,
  },
) {
  override get message() {
    return (
      `Billing stack '${this.fqn}' was recorded with version ${this.deployed}, but this build only knows up to version ${this.current}. ` +
      "Deploy it with the build that recorded it, or a newer one."
    );
  }
}

export const BillingStackAttrs = Schema.Struct({
  /** The shape version recorded with the state; see `BILLING_STACK_VERSION`. */
  version: Schema.Int,
  catalog: Catalog,
  tiers: Schema.Array(Schema.String),
  providers: Schema.Array(ProviderDescriptor),
  store: BillingStore,
});

export type BillingStackAttrs = typeof BillingStackAttrs.Type;

const refuseBillingStackDowngrade = (
  fqn: string,
  output: BillingStackAttrs | undefined,
): Effect.Effect<void, BillingStackVersionTooNew> =>
  output !== undefined &&
  billingStackVersionDecision(BILLING_STACK_VERSION, output.version) === "too-new"
    ? Effect.fail(
        new BillingStackVersionTooNew({
          fqn,
          deployed: output.version,
          current: BILLING_STACK_VERSION,
        }),
      )
    : Effect.void;

export type BillingStackShape = Resource<
  "Paykit.BillingStack",
  BillingStackRecord,
  BillingStackAttrs
>;

/**
 * The deploy-time billing stack: it records the validated catalog, the provider
 * descriptors and the store kind, retains on removal, and versions that state
 * shape with `BILLING_STACK_VERSION`.
 *
 * Reconcile re-validates the catalog and every provider mapping, so a deploy
 * whose catalog no longer validates fails with a tagged error instead of
 * recording half a stack. The attrs carry the catalog, the tier ids a console
 * can list, the provider descriptors and the store kind.
 *
 * Removal is `retain`: Alchemy drops the recorded state without calling the
 * provider's (no-op) delete. The event log lives in the store, not in this
 * resource, so destroying the stack never cancels a subscription, refunds a
 * charge or deletes a customer.
 *
 * @resource
 * @product Billing
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
 * State from an older version is rewritten in the current one. State from a
 * newer version is a refusal: a normal deploy must not overwrite what a newer
 * build recorded.
 *
 * A catalog that does not validate fails the deploy with its tagged error
 * rather than recording half a stack.
 */
export const reconcileBillingStack = (
  fqn: string,
  props: BillingStackRecord | undefined,
  output?: BillingStackAttrs,
): Effect.Effect<
  BillingStackAttrs,
  | CatalogError
  | CatalogPriceMismatch
  | NoPurchasePath
  | ProviderDuplicate
  | BillingStackVersionTooNew
> =>
  Effect.gen(function* () {
    yield* refuseBillingStackDowngrade(fqn, output);

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
 * so the engine creates it. An older record is returned as it is: the reconcile
 * that follows rewrites it in the current shape. A read of a newer record is a
 * typed refusal, because an older build would otherwise move that state back to
 * a layout it does not understand.
 */
export const readBillingStack = (
  fqn: string,
  output: BillingStackAttrs | undefined,
): Effect.Effect<BillingStackAttrs | undefined, BillingStackVersionTooNew> =>
  output === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        yield* refuseBillingStackDowngrade(fqn, output);

        return output;
      });

/**
 * Force an update when the recorded shape is older than this build, and refuse
 * a shape a newer build wrote. A deploy whose props did not change is
 * otherwise a no-op, so the next reconcile would never rewrite the record in
 * the current shape.
 */
export const diffBillingStack = (
  fqn: string,
  output: BillingStackAttrs | undefined,
): Effect.Effect<{ readonly action: "update" } | undefined, BillingStackVersionTooNew> =>
  Effect.gen(function* () {
    yield* refuseBillingStackDowngrade(fqn, output);

    return output !== undefined &&
      billingStackVersionDecision(BILLING_STACK_VERSION, output.version) === "update"
      ? { action: "update" as const }
      : undefined;
  });

/**
 * The Alchemy provider for `BillingStack`. Diff and reconcile judge the
 * recorded version; delete touches nothing, because the event log is
 * application data and cancelling a live subscription from a destroy is a
 * support incident.
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
    diff: ({ fqn, output }) => diffBillingStack(fqn, output),
    reconcile: ({ fqn, news, output }) => reconcileBillingStack(fqn, news, output),
    read: ({ fqn, output }) => readBillingStack(fqn, output),
    delete: () => Effect.void,
  });
