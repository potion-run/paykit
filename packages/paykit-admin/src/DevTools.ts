import { Subscription, tierTermsOf, type Allowance } from "@potion.run/paykit";
import type { Catalog } from "@potion.run/paykit";
import {
  type BillingStateView,
  type EntitlementsState,
  type FeatureEntitlement,
  type HoldRecord,
  type Refs,
  BillingReadRow,
  AccountId,
  SubscriptionStatus,
  standingOf,
  AccountEvent,
} from "@potion.run/paykit/Read";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The event tags the aggregate declares. The coverage test uses them to keep
 * the lab's payload table complete; the table, not this list, is what the
 * select renders.
 */
export const subscriptionEventTags: ReadonlyArray<string> = Subscription.definition.events.map(
  (event) => event.tag,
);

/** One event the lab can put in the feed, with a representative payload. */
export const DevToolsEvent = Schema.Struct({
  tag: Schema.String,
  body: Schema.String,
});
export type DevToolsEvent = typeof DevToolsEvent.Type;

const body = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(value);

/**
 * The events an operator can inject, with a payload that is worth looking at.
 * The body is display-only: `ReceivedEvent` never decodes it, so a lab payload
 * cannot move the console's billing model. A coverage test fails when the
 * aggregate grows an event this table does not name.
 */
export const devToolsEvents: ReadonlyArray<DevToolsEvent> = [
  {
    tag: "TrialStarted",
    body: body({
      tier: "pro",
      allowances: {},
      remaining: {},
      credits: 200,
      creditsExpire: "period",
      rates: {},
      periodStart: "2030-01-01T00:00:00Z",
      periodEnd: "2030-01-15T00:00:00Z",
      anchorTz: "UTC",
      trialEndsAt: "2030-01-15T00:00:00Z",
      statusAfter: "trialing",
    }),
  },
  {
    tag: "SubscriptionActivated",
    body: body({
      tier: "pro",
      allowances: {},
      remaining: {},
      credits: 500,
      creditsExpire: "period",
      rates: {},
      periodStart: "2030-01-01T00:00:00Z",
      periodEnd: "2030-02-01T00:00:00Z",
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      statusAfter: "active",
    }),
  },
  {
    tag: "TierChanged",
    body: body({
      tier: "pro",
      allowances: {},
      remaining: {},
      credits: 500,
      creditsExpire: "period",
      rates: {},
      currency: "usd",
      interval: "month",
      priceBefore: { amount: 900, currency: "usd", interval: "month" },
      priceAfter: { amount: 1900, currency: "usd", interval: "month" },
    }),
  },
  {
    tag: "UsageRecorded",
    body: body({
      feature: "messages",
      amount: 120,
      cost: 120,
      creditsAfter: 380,
      usedAfter: 1_120,
      remainingAfter: 880,
      charge: 0,
      billedAfter: 0,
    }),
  },
  {
    tag: "PaymentRecorded",
    body: body({ amount: 1_900, currency: "usd", statusAfter: "active" }),
  },
  {
    tag: "PaymentFailed",
    body: body({
      reason: "card_declined",
      graceUntilAfter: "2030-01-08T00:00:00Z",
      statusAfter: "grace",
      attempt: 1,
      dunningStartedAt: "2030-01-01T00:00:00Z",
    }),
  },
  {
    tag: "GraceEntered",
    body: body({ graceUntil: "2030-01-08T00:00:00Z", statusAfter: "grace" }),
  },
  {
    tag: "DunningRetryDue",
    body: body({
      attempt: 2,
      startedAt: "2030-01-01T00:00:00Z",
      amount: 1_900,
      currency: "usd",
    }),
  },
  {
    tag: "Recovered",
    body: body({ statusAfter: "active" }),
  },
  {
    tag: "CreditsGranted",
    body: body({ amount: 500, balanceAfter: 1_000 }),
  },
  {
    tag: "CreditsPurchased",
    body: body({
      tier: "pack_500",
      amount: 500,
      price: { amount: 2_500, currency: "usd", interval: "month" },
      balanceAfter: 1_500,
      prepaidAfter: 500,
    }),
  },
  {
    tag: "CreditsConsumed",
    body: body({ amount: 120, balanceAfter: 1_380 }),
  },
  {
    tag: "CreditsExpired",
    body: body({ amount: 200, balanceAfter: 0 }),
  },
  {
    tag: "SubscriptionExpired",
    body: body({ statusAfter: "expired" }),
  },
  {
    tag: "TrialExtended",
    body: body({
      trialEndsAt: "2030-01-22T00:00:00Z",
      periodEnd: "2030-01-22T00:00:00Z",
    }),
  },
  {
    tag: "CancellationScheduled",
    body: body({ cancelAtPeriodEndAfter: true }),
  },
  {
    tag: "CancellationWithdrawn",
    body: body({ cancelAtPeriodEndAfter: false }),
  },
  {
    tag: "UsageReserved",
    body: body({
      holdId: "hold_dev_1",
      feature: "messages",
      amount: 100,
      rate: 0,
      cost: 0,
      at: "2030-01-01T00:00:00Z",
      expiresAt: "2030-01-01T01:00:00Z",
      remainingAfter: 1_900,
    }),
  },
  {
    tag: "UsageSettled",
    body: body({
      holdId: "hold_dev_1",
      feature: "messages",
      amount: 100,
      released: 0,
      cost: 0,
      remainingAfter: 1_800,
    }),
  },
  {
    tag: "UsageReleased",
    body: body({
      holdId: "hold_dev_1",
      feature: "messages",
      amount: 100,
      cost: 0,
      remainingAfter: 1_900,
    }),
  },
  {
    tag: "PeriodClosed",
    body: body({
      periodStart: "2030-01-01T00:00:00Z",
      periodEnd: "2030-02-01T00:00:00Z",
      nextPeriodStart: "2030-02-01T00:00:00Z",
      nextPeriodEnd: "2030-03-01T00:00:00Z",
      statusAfter: "active",
      standingAfter: "good",
      cancelAtPeriodEndAfter: false,
    }),
  },
  {
    tag: "UsageReset",
    body: body({ remaining: { messages: 2_000 }, carried: { messages: 0 } }),
  },
  {
    tag: "QuantityChanged",
    body: body({
      feature: "seats",
      quantityBefore: 5,
      quantityAfter: 8,
      proration: { currency: "usd", credit: 0, charge: 3_000, due: 3_000 },
      prorationId: "seats:add",
    }),
  },
  {
    tag: "QuantityProrationInvoiced",
    body: body({
      prorationId: "seats:add",
      invoiceId: "in_1",
      amount: 3_000,
      currency: "usd",
    }),
  },
  {
    tag: "AllowanceReset",
    body: body({
      feature: "messages",
      remaining: 100,
      carried: 0,
      resetAt: "2030-01-02T00:00:00Z",
    }),
  },
  {
    tag: "ProrationInvoiced",
    body: body({ invoiceId: "in_dev_1", amount: 950, currency: "usd" }),
  },
  {
    tag: "TierChangeScheduled",
    body: body({
      tier: "pro",
      allowances: {},
      credits: 500,
      creditsExpire: "period",
      rates: {},
    }),
  },
  {
    tag: "TierChangeWithdrawn",
    body: body({ tier: "pro" }),
  },
  {
    tag: "ProviderRefAttached",
    body: body({ provider: "manual", refs: {} }),
  },
  {
    tag: "TopUpCooldownCleared",
    body: body({}),
  },
  {
    tag: "RefundRecorded",
    body: body({
      chargeId: "ch_dev_1",
      refundId: "re_dev_1",
      amount: 1_900,
      currency: "usd",
      commandId: "refund_dev_1",
      reason: "duplicate order",
      refundedAfter: 1_900,
    }),
  },
];

export const DevToolsTab = Schema.Literals(["events", "reads", "feed"]);
export type DevToolsTab = typeof DevToolsTab.Type;

/** The tabs the floating panel shows, in the order they appear. */
export const devToolsTabs: ReadonlyArray<{ readonly tab: DevToolsTab; readonly label: string }> = [
  { tab: "events", label: "Events" },
  { tab: "reads", label: "Reads" },
  { tab: "feed", label: "Feed" },
];

/** The lab's own controls, separate from the billing Model. */
export const DevToolsState = Schema.Struct({
  isEnabled: Schema.Boolean,
  isOpen: Schema.Boolean,
  tab: DevToolsTab,
  accountId: Schema.String,
  eventTag: Schema.String,
  eventBody: Schema.String,
  commandId: Schema.String,
  emitted: Schema.Int,
  seedTier: Schema.String,
  seedStatus: SubscriptionStatus,
  seedCredits: Schema.String,
  seedUsage: Schema.String,
  /** Rows the lab seeded locally; they never reach the server projection. */
  labRows: Schema.Array(BillingReadRow),
});
export type DevToolsState = typeof DevToolsState.Type;

const firstEvent = Option.getOrThrow(Array.head(devToolsEvents));

/** The state a host gets when it opts into the lab through `Flags.devTools`. */
export const initialDevToolsState = (isEnabled: boolean): DevToolsState => ({
  isEnabled,
  isOpen: false,
  tab: "events",
  accountId: "acct_dev",
  eventTag: firstEvent.tag,
  eventBody: firstEvent.body,
  commandId: "devtools_command",
  emitted: 0,
  seedTier: "pro",
  seedStatus: "active",
  seedCredits: "500",
  seedUsage: "250",
  labRows: [],
});

/** The default payload for a tag, so changing the select resets the body. */
export const devToolsEventOf = (tag: string): Option.Option<DevToolsEvent> =>
  Array.findFirst(devToolsEvents, (event) => event.tag === tag);

/**
 * Decode a lab payload back into the aggregate event it names. The body is
 * display-only until now; this is what lets an emitted event enter the same
 * timeline fold as the live feed.
 */
const reviveDates = (value: unknown): unknown => {
  if (typeof value === "string") {
    const date = DateTime.make(value);
    return Option.isSome(date) ? date.value : value;
  }
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, reviveDates(entry)]),
    );
  }
  return value;
};

export const decodeDevToolsEvent = (event: DevToolsEvent): Option.Option<AccountEvent> => {
  try {
    const body = reviveDates(JSON.parse(event.body)) as Record<string, unknown>;
    return Schema.decodeUnknownOption(AccountEvent)({ _tag: event.tag, ...body });
  } catch {
    return Option.none();
  }
};

/**
 * A deterministic clock for simulated events. A lab that read `Date.now()`
 * would make every test and every reload disagree, so the first event starts
 * at a known instant and each later one is a second after the one before.
 */
const simulatedStart = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

export const simulatedAt = (seq: number): DateTime.Utc =>
  DateTime.add(simulatedStart, { seconds: seq });

/** The next sequence number for an account's feed. */
export const nextEventSeq = (account: {
  readonly cursor: Option.Option<number>;
  readonly events: ReadonlyArray<{ readonly seq: number }>;
}): number => {
  const cursor = Option.getOrElse(account.cursor, () => 0);
  const newest = Array.reduce(account.events, 0, (max, event) => Math.max(max, event.seq));
  return Math.max(cursor, newest) + 1;
};

const seedTier = (catalog: Option.Option<Catalog>): string =>
  Option.match(catalog, {
    onNone: () => "pro",
    onSome: (value) =>
      Option.match(Array.head(value.tiers), {
        onNone: () => "pro",
        onSome: (tier) => tier.id,
      }),
  });

const seedTerms = (catalog: Option.Option<Catalog>, tier: string) =>
  Option.flatMap(catalog, (value) => Option.fromNullishOr(tierTermsOf(value, tier)));

const seedFeature = (catalog: Option.Option<Catalog>): string =>
  Option.match(catalog, {
    onNone: () => "messages",
    onSome: (value) =>
      Option.match(Array.head(value.features), {
        onNone: () => "messages",
        onSome: (feature) => feature.id,
      }),
  });

const seedEntitlement = (
  allowance: Allowance,
  status: SubscriptionStatus,
  periodEnd: DateTime.Utc,
  reserved: number,
): FeatureEntitlement => {
  const isFlag = allowance.kind === "flag";
  const included = allowance.included;
  const used = isFlag || included === "unlimited" ? 0 : Math.floor(included / 8);
  const remaining =
    isFlag || included === "unlimited" ? null : Math.max(0, included - used - reserved);
  return {
    kind: allowance.kind ?? "metered",
    included,
    used,
    reserved,
    remaining,
    carried: 0,
    allowed: status === "trialing" || status === "active" || status === "grace",
    overage: allowance.overage,
    resets: allowance.resets,
    resetsAt: allowance.resets === "never" ? null : periodEnd,
    ...(allowance.cap === undefined ? {} : { cap: allowance.cap }),
    ...(allowance.unitPrice === undefined ? {} : { unitPrice: allowance.unitPrice }),
    ...(allowance.moneyCap === undefined ? {} : { moneyCap: allowance.moneyCap }),
  };
};

/**
 * A standing an operator can look at without a server: the catalog's first
 * tier, an active period that starts at the simulated clock, and enough used
 * units for the allowance table to have a shape.
 */
export const devToolsBilling = (
  account: AccountId,
  catalog: Option.Option<Catalog>,
  status: SubscriptionStatus,
  at: DateTime.Utc,
  tier: string = seedTier(catalog),
): BillingStateView => {
  const terms = seedTerms(catalog, tier);
  const periodEnd = DateTime.add(at, { months: 1 });
  const price = Option.getOrUndefined(
    Option.flatMap(terms, (value) => Option.fromNullishOr(value.price)),
  );
  const credits = Option.getOrElse(
    Option.map(terms, (value) => value.credits),
    () => 0,
  );
  const pending = Option.getOrUndefined(
    Option.flatMap(catalog, (value) =>
      Option.flatMap(
        Array.findFirst(value.tiers, (entry) => entry.id !== tier),
        (entry) =>
          Option.map(Option.fromNullishOr(tierTermsOf(value, entry.id)), (pendingTerms) => ({
            tier: entry.id,
            terms: pendingTerms,
          })),
      ),
    ),
  );
  return {
    account,
    tier,
    status,
    periodStart: at,
    periodEnd,
    interval: "month",
    anchorTz: "UTC",
    cancelAtPeriodEnd: false,
    credits,
    dunningAttempts: status === "grace" ? 1 : 0,
    ...(price === undefined ? {} : { price, currency: price.currency }),
    ...(status === "trialing" ? { trialEndsAt: DateTime.add(at, { days: 14 }) } : {}),
    ...(status === "grace" ? { graceUntil: DateTime.add(at, { days: 7 }) } : {}),
    ...(pending === undefined
      ? {}
      : {
          pendingTier: {
            tier: pending.tier,
            allowances: pending.terms.allowances,
            credits: pending.terms.credits,
            creditsExpire: pending.terms.creditsExpire,
            rates: pending.terms.rates,
            ...(pending.terms.price === undefined
              ? {}
              : {
                  price: pending.terms.price,
                  currency: pending.terms.price.currency,
                  interval: pending.terms.price.interval,
                }),
          },
        }),
  };
};

/** The `check()` read model for the same simulated standing. */
export const devToolsEntitlements = (
  account: AccountId,
  catalog: Option.Option<Catalog>,
  status: SubscriptionStatus,
  at: DateTime.Utc,
  holds: ReadonlyArray<HoldRecord> = [],
  tier: string = seedTier(catalog),
): EntitlementsState => {
  const terms = seedTerms(catalog, tier);
  const periodEnd = DateTime.add(at, { months: 1 });
  const allowances = Option.map(terms, (value) => value.allowances);
  const reservedOf = (feature: string): number =>
    Array.reduce(holds, 0, (total, hold) =>
      hold.feature === feature && hold.status === "open" ? total + hold.amount : total,
    );
  const features = Option.match(allowances, {
    onNone: () => {
      const feature = seedFeature(catalog);
      const reserved = reservedOf(feature);
      return {
        [feature]: {
          kind: "metered" as const,
          included: 2_000,
          used: 250,
          reserved,
          remaining: Math.max(0, 1_750 - reserved),
          carried: 0,
          allowed: status === "trialing" || status === "active" || status === "grace",
          overage: "block" as const,
          resets: "month" as const,
          resetsAt: periodEnd,
        },
      };
    },
    onSome: (value) =>
      Object.fromEntries(
        Object.entries(value).map(([feature, allowance]) => [
          feature,
          seedEntitlement(allowance, status, periodEnd, reservedOf(feature)),
        ]),
      ),
  });
  return {
    account,
    tier,
    status,
    standing: standingOf(status),
    periodStart: at,
    periodEnd,
    cancelAtPeriodEnd: false,
    credits: Option.getOrElse(
      Option.map(terms, (value) => value.credits),
      () => 0,
    ),
    dunningAttempts: status === "grace" ? 1 : 0,
    features,
  };
};

/** One fake vendor reference per provider key, so the refs panel has rows. */
export const devToolsProviderRefs = (account: AccountId): Refs => ({
  manual: {
    customer: `cus_${account}`,
    subscription: `sub_${account}`,
    checkout: `chk_${account}`,
  },
});

/** Two open holds and one settled hold, so the hold history has every status. */
export const devToolsHolds = (
  account: AccountId,
  catalog: Option.Option<Catalog>,
  at: DateTime.Utc,
): ReadonlyArray<HoldRecord> => {
  const feature = seedFeature(catalog);
  const hold = (
    id: string,
    amount: number,
    hours: number,
    status: HoldRecord["status"] = "open",
  ): HoldRecord => ({
    id,
    feature,
    amount,
    rate: 0,
    cost: 0,
    at,
    expiresAt: DateTime.add(at, { hours }),
    status,
  });
  return [
    hold(`hold_${account}_1`, 120, 2),
    hold(`hold_${account}_2`, 40, 6),
    hold(`hold_${account}_3`, 30, -2, "settled"),
  ];
};
