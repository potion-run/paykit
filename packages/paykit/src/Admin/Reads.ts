import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import { CrossOrigin } from "../Auth/CrossOrigin.rejection.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Admin } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { listOperation } from "../Billing/List.operation.ts";
import { previewOperation, type PreviewResult } from "../Billing/Preview.operation.ts";
import {
  BillingReadPage,
  BillingReadQuery,
  BillingReadStore,
  type BillingReadRow,
  type BillingReadSummary,
} from "../BillingReadStore.ts";
import { Catalog } from "../Catalog.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CatalogService } from "../CatalogService.ts";
import { Proration } from "../Proration.ts";
import { AlreadyCanceled } from "../Subscription/AlreadyCanceled.rejection.ts";
import { PlanChanged } from "../Subscription/ChangeTier.command.ts";
import {
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
} from "../Subscription/ChangeTier.command.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { ProrationMismatch } from "../Subscription/ProrationMismatch.rejection.ts";
import { CancellationScheduled } from "../Subscription/ScheduleCancellation.command.ts";
import { PlanChangeScheduled } from "../Subscription/ScheduleTierChange.command.ts";
import { StandingEnded } from "../Subscription/StandingEnded.rejection.ts";
import { SubscriptionActivated } from "../Subscription/Subscribe.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import {
  HoldRecord,
  Refs,
  Standing,
  SubscriptionState,
  SubscriptionStatus,
} from "../Subscription/Subscription.state.ts";
import { NoTierChangeScheduled } from "../Subscription/WithdrawTierChange.command.ts";
import { TierChangeWithdrawn } from "../Subscription/WithdrawTierChange.command.ts";
import type { Price } from "../Tier.ts";
import { Verify, VerifyMismatch } from "../Verify.ts";

/** A preview that could not be turned into a wire value. */
export class AdminReadFailed extends Schema.TaggedError<AdminReadFailed>()("AdminReadFailed", {
  /** The transport failure as a tag: offline, timeout, protocol mismatch, … */
  reason: Schema.String,
  message: Schema.String,
}) {}

/** Every way an admin read can fail before it returns a domain answer. */
export const AdminReadError = Schema.Union([
  Unauthenticated,
  Forbidden,
  // The `Admin` guard refuses a cross-origin unsafe request before it resolves
  // a caller, and that refusal reaches an RPC's error channel too (ADR 0033).
  CrossOrigin,
  AdminReadFailed,
]);

export type AdminReadError = typeof AdminReadError.Type;

/** The events a preview can report. */
export const PreviewEvents = Schema.Union([
  SubscriptionActivated,
  PlanChanged,
  PlanChangeScheduled,
  TierChangeWithdrawn,
  CancellationScheduled,
]);

export type PreviewEvents = typeof PreviewEvents.Type;

/** The rejections a preview can report as data rather than a transport failure. */
export const PreviewRejection = Schema.Union([
  PlanNotInCatalog,
  NotSubscribed,
  StandingEnded,
  CurrencyMismatch,
  DowngradeBelowUsage,
  DowngradeBelowSpend,
  DowngradeBelowCeiling,
  AlreadyCanceled,
  NoTierChangeScheduled,
  ProrationMismatch,
  CatalogMismatch,
]);

export type PreviewRejection = typeof PreviewRejection.Type;

/** What `decide` would record, in a form that can cross a wire. */
export const PreviewAccepted = Schema.TaggedStruct("accepted", {
  state: SubscriptionState,
  events: Schema.Array(PreviewEvents),
  proration: Schema.optionalKey(Proration),
});

export const PreviewRejected = Schema.TaggedStruct("rejected", {
  rejection: PreviewRejection,
});

/**
 * The model could not decide the command. A cause is not serialized: a
 * console only needs to know that the answer is unavailable and must ask the
 * server to apply the command.
 */
export const PreviewUnpredictable = Schema.TaggedStruct("unpredictable", {
  reason: Schema.String,
});

/** The wire form of `PreviewResult`. */
export const PreviewAnswer = Schema.Union([PreviewAccepted, PreviewRejected, PreviewUnpredictable]);

export type PreviewAnswer = typeof PreviewAnswer.Type;

/**
 * One account's holds, as the aggregate records them. The two views fold a
 * hold into `reserved` counts, so a console that needs the entity itself — its
 * id, feature, price and deadline — reads them here.
 */
export const HoldsAnswer = Schema.Struct({
  account: Schema.String,
  /** Every hold the account has taken, open and closed, newest first. */
  holds: Schema.Array(HoldRecord),
  /** When the aggregate answered. A hold list is a snapshot, like the account list. */
  asOf: Schema.DateTimeUtc,
});

export type HoldsAnswer = typeof HoldsAnswer.Type;

/** The vendor ids attached to one account, one entry per provider. */
export const ProviderRefsAnswer = Schema.Struct({
  account: Schema.String,
  /** `provider -> { customer, subscription, checkout }`, opaque to the model. */
  refs: Refs,
  /** When the aggregate answered. A refs list is a snapshot, like the holds list. */
  asOf: Schema.DateTimeUtc,
});

export type ProviderRefsAnswer = typeof ProviderRefsAnswer.Type;

/** One currency's recurring revenue, from the rows and the catalog's prices. */
export const RevenueSummary = Schema.Struct({
  currency: Schema.String,
  /** Monthly recurring revenue in minor units; an annual price is divided by 12. */
  mrr: Schema.Int,
  arr: Schema.Int,
  /** Recurring revenue on trials, not yet paying. */
  trialPipeline: Schema.Int,
  /** The part of `mrr` that is in grace and may churn. */
  atRisk: Schema.Int,
  /** Recurring revenue already canceled or expired. */
  churned: Schema.Int,
});

export type RevenueSummary = typeof RevenueSummary.Type;

export const TierCount = Schema.Struct({ tier: Schema.String, count: Schema.Int });

export type TierCount = typeof TierCount.Type;

export const StatusCount = Schema.Struct({ status: SubscriptionStatus, count: Schema.Int });

export type StatusCount = typeof StatusCount.Type;

export const StandingCount = Schema.Struct({ standing: Standing, count: Schema.Int });

export type StandingCount = typeof StandingCount.Type;

/** Why an account needs an operator's attention, from the read model alone. */
export const AttentionReason = Schema.Literals(["past_due", "canceling", "usage_limit_reached"]);

export type AttentionReason = typeof AttentionReason.Type;

/** One account the dashboard should surface first, with every reason it qualifies. */
export const AttentionRow = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  status: SubscriptionStatus,
  standing: Standing,
  periodEnd: Schema.DateTimeUtc,
  /** Failed payments recorded on this standing, shown beside the reason. */
  dunningAttempts: Schema.Int,
  reasons: Schema.Array(AttentionReason),
});

export type AttentionRow = typeof AttentionRow.Type;

/** A cross-account read for the dashboard: counts, revenue and the attention page. */
export const BillingOverview = Schema.Struct({
  asOf: Schema.DateTimeUtc,
  accounts: Schema.Int,
  byStatus: Schema.Array(StatusCount),
  byStanding: Schema.Array(StandingCount),
  byTier: Schema.Array(TierCount),
  revenue: Schema.Array(RevenueSummary),
  /** The first page of accounts that need attention, newest reason first. */
  attention: Schema.optionalKey(Schema.Array(AttentionRow)),
  /** How many accounts have at least one attention reason, not just the page. */
  attentionCount: Schema.optionalKey(Schema.Int),
});

export type BillingOverview = typeof BillingOverview.Type;

const ATTENTION_ORDER: ReadonlyArray<AttentionReason> = [
  "past_due",
  "canceling",
  "usage_limit_reached",
];

const ATTENTION_PAGE = 20;

const attentionReasonsOf = (row: BillingReadRow): ReadonlyArray<AttentionReason> => {
  const reasons: Array<AttentionReason> = [];

  // A canceled or expired standing is history, not a customer who needs help.
  if (row.status === "canceled" || row.status === "expired") return reasons;

  if (row.status === "grace") reasons.push("past_due");

  if (row.cancelAtPeriodEnd) reasons.push("canceling");

  if (Object.values(row.features).some((feature) => feature.allowed === false))
    reasons.push("usage_limit_reached");

  return reasons;
};

const attentionOf = (row: BillingReadRow): AttentionRow | null => {
  const reasons = attentionReasonsOf(row);

  if (reasons.length === 0) return null;

  return {
    account: row.account,
    tier: row.tier,
    status: row.status,
    standing: row.standing,
    periodEnd: row.periodEnd,
    dunningAttempts: row.dunningAttempts,
    reasons,
  };
};

const STATUS_ORDER: ReadonlyArray<SubscriptionStatus> = [
  "trialing",
  "active",
  "grace",
  "canceled",
  "expired",
];

const STANDING_ORDER: ReadonlyArray<Standing> = ["good", "grace", "blocked"];

const monthlyPriceOf = (price: Price | undefined): number => {
  if (price === undefined) return 0;

  return price.interval === "annual" ? Math.round(price.amount / 12) : price.amount;
};

const overviewOf = (
  summaries: ReadonlyArray<BillingReadSummary>,
  attentionRows: ReadonlyArray<BillingReadRow>,
  catalog: Catalog,
  asOf: DateTime.Utc,
): BillingOverview => {
  const statusCounts = new Map(STATUS_ORDER.map((status) => [status, 0]));
  const standingCounts = new Map(STANDING_ORDER.map((standing) => [standing, 0]));
  const tierCounts = new Map<string, number>(catalog.tiers.map((tier) => [String(tier.id), 0]));

  // One lookup per tier, not one scan of the catalog per row: the monthly price
  // depends only on the tier, so the summary's counts multiply it.
  const prices = new Map<string, Price | undefined>(
    catalog.tiers.map((tier) => [String(tier.id), tier.price]),
  );

  const revenue = new Map<
    string,
    { mrr: number; trialPipeline: number; atRisk: number; churned: number }
  >();

  let accounts = 0;

  for (const summary of summaries) {
    accounts += summary.accounts;
    statusCounts.set(summary.status, (statusCounts.get(summary.status) ?? 0) + summary.accounts);
    standingCounts.set(
      summary.standing,
      (standingCounts.get(summary.standing) ?? 0) + summary.accounts,
    );
    tierCounts.set(summary.tier, (tierCounts.get(summary.tier) ?? 0) + summary.accounts);

    const price = prices.get(summary.tier);
    const monthly = monthlyPriceOf(price);
    const currency = price?.currency;

    if (currency === undefined || monthly === 0) continue;

    const entry = revenue.get(currency) ?? {
      mrr: 0,
      trialPipeline: 0,
      atRisk: 0,
      churned: 0,
    };

    const amount = monthly * summary.accounts;

    if (summary.status === "active" || summary.status === "grace") {
      entry.mrr += amount;

      if (summary.status === "grace") entry.atRisk += amount;
    } else if (summary.status === "trialing") {
      entry.trialPipeline += amount;
    } else {
      entry.churned += amount;
    }

    revenue.set(currency, entry);
  }

  const attention = attentionRows
    .flatMap((row) => {
      const entry = attentionOf(row);

      return entry === null ? [] : [entry];
    })
    .toSorted((left, right) => {
      const leftRank = ATTENTION_ORDER.indexOf(left.reasons[0] ?? "usage_limit_reached");
      const rightRank = ATTENTION_ORDER.indexOf(right.reasons[0] ?? "usage_limit_reached");

      return leftRank - rightRank || left.account.localeCompare(right.account);
    });

  return BillingOverview.make({
    asOf,
    accounts,
    byStatus: STATUS_ORDER.map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
    byStanding: STANDING_ORDER.map((standing) => ({
      standing,
      count: standingCounts.get(standing) ?? 0,
    })),
    byTier: [...tierCounts].map(([tier, count]) => ({ tier, count })),
    revenue: [...revenue]
      .map(([currency, value]) => ({
        currency,
        mrr: value.mrr,
        arr: value.mrr * 12,
        trialPipeline: value.trialPipeline,
        atRisk: value.atRisk,
        churned: value.churned,
      }))
      .toSorted((left, right) => left.currency.localeCompare(right.currency)),
    attention: attention.slice(0, ATTENTION_PAGE),
    attentionCount: attention.length,
  });
};

/** The preview request schema, matching `PreviewInput`'s `kind` discriminant. */
export const PreviewCommandSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("subscribe"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("changeTier"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cancel") }),
]);

export const AdminPreviewInput = Schema.Struct({
  account: Schema.String,
  command: PreviewCommandSchema,
});

export type AdminPreviewInput = typeof AdminPreviewInput.Type;

const previewRejectionOf = (value: unknown): PreviewRejection | null =>
  Option.getOrNull(Schema.decodeUnknownOption(PreviewRejection)(value));

/**
 * Turn the in-process preview result into its wire form. A recognized
 * rejection stays data; an unrecognized one becomes `unpredictable` rather
 * than being cast.
 */
export const previewAnswerOf = (result: PreviewResult): PreviewAnswer => {
  if (result._tag === "accepted") {
    const events: Array<PreviewEvents> = [];

    for (const event of result.events) {
      const decoded = Schema.decodeUnknownOption(PreviewEvents)(event);

      if (Option.isNone(decoded)) {
        return PreviewUnpredictable.make({
          reason: "the model produced a preview event the console cannot display",
        });
      }

      events.push(decoded.value);
    }

    return PreviewAccepted.make({
      state: result.state,
      events,
      ...(result.proration === undefined ? {} : { proration: result.proration }),
    });
  }

  if (result._tag === "rejected") {
    const rejection = previewRejectionOf(result.rejection);

    return rejection === null
      ? PreviewUnpredictable.make({ reason: "the model returned an unrecognized rejection" })
      : PreviewRejected.make({ rejection });
  }

  return PreviewUnpredictable.make({ reason: "the model could not decide this command" });
};

/** The read surface an ops console needs, over the model's own bindings. */
export interface AdminReadsShape {
  /** One page of accounts, from the `BillingRead` projection. */
  readonly list: (query?: BillingReadQuery) => Effect.Effect<BillingReadPage, AdminReadError>;
  /** What `decide` would do, without recording it. */
  readonly preview: (input: AdminPreviewInput) => Effect.Effect<PreviewAnswer, AdminReadError>;
  /** An account's standing against the deploy's catalog and provider. */
  readonly verify: (input: {
    readonly account: string;
  }) => Effect.Effect<ReadonlyArray<VerifyMismatch>, AdminReadError>;
  /** An account's holds, which the views fold away into reserved counts. */
  readonly holds: (account: string) => Effect.Effect<HoldsAnswer, AdminReadError>;
  /** The vendor ids attached to an account, per provider. */
  readonly providerRefs: (account: string) => Effect.Effect<ProviderRefsAnswer, AdminReadError>;
  /** Cross-account counts and recurring revenue for the dashboard. */
  readonly overview: () => Effect.Effect<BillingOverview, AdminReadError>;
  /** The catalog the deployment validated, for tier choices and prices. */
  readonly catalog: () => Effect.Effect<Catalog, AdminReadError>;
}

/**
 * The console's read port. It is deliberately separate from `BillingAdminApi`:
 * a Domain Api serves keyed reads, while an account list spans keys and
 * `Preview`/`Verify` are bindings over the pure model. A console needs both,
 * and this service is the one it depends on.
 *
 * @primitive
 */
export class AdminReads extends Context.Service<AdminReads, AdminReadsShape>()(
  "paykit/AdminReads",
) {}

/**
 * Build the read port from the in-process bindings. Provide the hosted model,
 * its `BillingReadStore` and the catalog; the same layer serves a test, an
 * `alchemy dev` console and a Worker that hosts the console beside the model.
 *
 * @layer
 */
export const makeAdminReads = Effect.gen(function* () {
  const list = yield* listOperation();
  const preview = yield* previewOperation();
  const verify = yield* Verify();
  const subscription = yield* Subscription;
  const catalog = yield* CatalogService;
  const store = yield* BillingReadStore;

  return {
    list: (query) => list(query),
    preview: (input) =>
      preview(input).pipe(
        Effect.map(previewAnswerOf),
        Effect.catchTags({
          PlanNotInCatalog: (rejection) => Effect.succeed(PreviewRejected.make({ rejection })),
          // A bespoke allowance set that disagrees with the catalog is the same
          // kind of answer for a console: a plan it cannot quote, with the
          // reason on the rejection.
          CatalogMismatch: (rejection) => Effect.succeed(PreviewRejected.make({ rejection })),
        }),
      ),
    verify: ({ account }) => verify({ account }),
    holds: (account) =>
      Effect.gen(function* () {
        const state = yield* subscription.state(Subscription.ref(account));
        const holds = state._tag === "Subscribed" ? Object.values(state.holds) : [];

        return HoldsAnswer.make({
          account,
          // Newest first: an operator opens this panel to see what is still
          // waiting, and the deadline is the number that matters.
          holds: holds.toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at) ||
              DateTime.toEpochMillis(right.expiresAt) - DateTime.toEpochMillis(left.expiresAt),
          ),
          asOf: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        });
      }),
    providerRefs: (account) =>
      Effect.gen(function* () {
        const state = yield* subscription.state(Subscription.ref(account));

        return ProviderRefsAnswer.make({
          account,
          refs: state.refs,
          asOf: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        });
      }),
    overview: () =>
      Effect.gen(function* () {
        const summaries = yield* store.summary();
        const attention = yield* store.attention();

        return overviewOf(
          summaries,
          attention,
          catalog,
          DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        );
      }),
    catalog: () => Effect.succeed(catalog),
  } satisfies AdminReadsShape;
});

/** The in-process console read port, as one Layer. */
export const AdminReadsLive = Layer.effect(AdminReads, makeAdminReads);

const VerifyInput = Schema.Struct({ account: Schema.String });

/**
 * The admin read contract as Effect RPC. Every call runs through the same
 * `Admin` middleware as the admin commands, so a tenant session cannot list
 * every account even if it reaches the endpoint.
 */
export const AdminReadsRpcs = RpcGroup.make(
  Rpc.make("ListAccounts", {
    payload: BillingReadQuery,
    success: BillingReadPage,
    error: AdminReadError,
  }),
  Rpc.make("Preview", {
    payload: AdminPreviewInput,
    success: PreviewAnswer,
    error: AdminReadError,
  }),
  Rpc.make("Verify", {
    payload: VerifyInput,
    success: Schema.Array(VerifyMismatch),
    error: AdminReadError,
  }),
  Rpc.make("Holds", {
    payload: VerifyInput,
    success: HoldsAnswer,
    error: AdminReadError,
  }),
  Rpc.make("ProviderRefs", {
    payload: VerifyInput,
    success: ProviderRefsAnswer,
    error: AdminReadError,
  }),
  Rpc.make("Overview", {
    success: BillingOverview,
    error: AdminReadError,
  }),
  Rpc.make("Catalog", {
    success: Catalog,
    error: AdminReadError,
  }),
).middleware(Admin);

/**
 * The RPC handlers, built from the hosted model. Serve them beside the
 * `BillingAdminApi`; the `Admin` middleware is part of `AdminReadsRpcs`.
 *
 * ### Serving the console reads beside the admin Api
 * **Example:** One Worker, two admin surfaces
 * ```typescript
 * const handlers = yield* AdminReadsHandlers;
 * const reads = RpcServer.toHttpEffect(AdminReadsRpcs).pipe(
 *   Effect.flatten,
 *   Effect.provide(
 *     Layer.mergeAll(
 *       AdminReadsRpcs.toLayer(handlers),
 *       RpcSerialization.layerNdjson,
 *       InsecureAdminFromHeaders,
 *     ),
 *   ),
 * );
 * ```
 */
export const AdminReadsHandlers = Effect.map(makeAdminReads, (reads) =>
  AdminReadsRpcs.of({
    ListAccounts: (query: BillingReadQuery) => reads.list(query),
    Preview: (input: AdminPreviewInput) => reads.preview(input),
    Verify: ({ account }: { readonly account: string }) => reads.verify({ account }),
    Holds: ({ account }: { readonly account: string }) => reads.holds(account),
    ProviderRefs: ({ account }: { readonly account: string }) => reads.providerRefs(account),
    Overview: () => reads.overview(),
    Catalog: () => reads.catalog(),
  }),
);

const transportFailure = (error: RpcClientError.RpcClientError): AdminReadFailed =>
  new AdminReadFailed({ reason: error.reason._tag, message: error.message });

/**
 * The browser/Worker client for `AdminReadsRpcs`, over Effect RPC's HTTP
 * protocol. Provide an `HttpClient` (for a browser, `FetchHttpClient.layer`);
 * the session cookie on the same origin authenticates every call.
 *
 * @layer
 */
export const AdminReadsClient = (
  url: string,
  options: {
    readonly headers?: Headers.Input;
    readonly transformClient?: <E, R>(
      client: HttpClient.HttpClient.With<E, R>,
    ) => HttpClient.HttpClient.With<E, R>;
  } = {},
): Layer.Layer<AdminReads, never, HttpClient.HttpClient> =>
  Layer.effect(
    AdminReads,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AdminReadsRpcs);

      const call = <A>(
        effect: Effect.Effect<A, AdminReadError | RpcClientError.RpcClientError>,
      ): Effect.Effect<A, AdminReadError> =>
        (options.headers === undefined
          ? effect
          : RpcClient.withHeaders(effect, options.headers)
        ).pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(transportFailure(error))));

      return {
        list: (query) => call(client.ListAccounts(query ?? {})),
        preview: (input) => call(client.Preview(input)),
        verify: ({ account }) => call(client.Verify({ account })),
        holds: (account) => call(client.Holds({ account })),
        providerRefs: (account) => call(client.ProviderRefs({ account })),
        overview: () => call(client.Overview()),
        catalog: () => call(client.Catalog()),
      } satisfies AdminReadsShape;
    }),
  ).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url,
        ...(options.transformClient === undefined
          ? {}
          : { transformClient: options.transformClient }),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  );
