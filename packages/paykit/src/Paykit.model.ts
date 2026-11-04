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
import { PeriodRollover, PeriodRolloverLive } from "./Subscription/PeriodRollover.policy.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/**
 * The billing model: one account-keyed aggregate, the read models that answer
 * from it, and the policies that roll periods and run dunning. Host it on a
 * `Domain.Platform`; `Stack` validates the deploy config, it does not host.
 */
export class PaykitModel extends Domain.Model("Paykit", {
  aggregates: [Subscription],
  views: [Entitlements, BillingState],
  streams: [AccountEvents],
  projections: [AccountEventsProjection, BillingRead],
  policies: [PeriodRollover, Dunning],
}) {}

/**
 * The projection and policy implementations. Provide a `BillingReadStore`;
 * the account stream and both policies need nothing else.
 */
export const PaykitHandlers = Layer.mergeAll(
  AccountEventsLive,
  BillingReadLive,
  PeriodRolloverLive,
  DunningLive,
);
