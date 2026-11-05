import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { AccountEvents } from "./Subscription/AccountEvents.stream.ts";
import {
  AccountEventsLive,
  AccountEventsProjection,
} from "./Subscription/AccountEventsProjection.ts";
import { BillingRead, BillingReadLive } from "./Subscription/BillingRead.projection.ts";
import { BillingState } from "./Subscription/BillingState.view.ts";
import { Dunning, DunningLive } from "./Subscription/Dunning.policy.ts";
import { Entitlements } from "./Subscription/Entitlements.view.ts";
import { HoldSweep, HoldSweepLive } from "./Subscription/HoldSweep.policy.ts";
import { PeriodCloseUsage, PeriodCloseUsageLive } from "./Subscription/PeriodCloseUsage.policy.ts";
import { PeriodRollover, PeriodRolloverLive } from "./Subscription/PeriodRollover.policy.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/**
 * The billing model: one account-keyed aggregate, the read models that answer
 * from it, and the policies that roll periods, push usage, run dunning and
 * release expired holds. Host it on a `Domain.Platform`; `Stack` validates the
 * deploy config, it does not host.
 */
export class PaykitModel extends Domain.Model("Paykit", {
  aggregates: [Subscription],
  views: [Entitlements, BillingState],
  streams: [AccountEvents],
  projections: [AccountEventsProjection, BillingRead],
  policies: [PeriodRollover, Dunning, HoldSweep, PeriodCloseUsage],
}) {}

/**
 * The projection and policy implementations. Provide a `BillingReadStore`;
 * the account stream and the policies need nothing else. Provide a
 * `PaymentsRouter` beside them to let `PeriodCloseUsage` push a closing
 * period's billable units to the account's provider; without one, closes are
 * local-only.
 */
export const PaykitHandlers = Layer.mergeAll(
  AccountEventsLive,
  BillingReadLive,
  PeriodRolloverLive,
  DunningLive,
  HoldSweepLive,
  PeriodCloseUsageLive,
);
