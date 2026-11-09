import * as Schema from "effect/Schema";
import { PlanId } from "./Plan.ts";

/** The account a deployment bills. */
export const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));

export type CustomerId = typeof CustomerId.Type;

/** One plan a customer holds, and the status the deployment sees. */
export const CustomerPlan = Schema.Struct({
  planId: PlanId,
  status: Schema.Literals(["trialing", "active", "grace", "canceled", "expired"]),
  scheduledPlanId: Schema.optionalKey(PlanId),
});

export type CustomerPlan = typeof CustomerPlan.Type;

/** A customer-level auto top-up line. */
export const CustomerAutoTopUp = Schema.Struct({
  featureId: Schema.String,
  enabled: Schema.Boolean,
  threshold: Schema.Int,
  quantity: Schema.Int,
});

export type CustomerAutoTopUp = typeof CustomerAutoTopUp.Type;

/** A customer-level spend limit. */
export const CustomerSpendLimit = Schema.Struct({
  featureId: Schema.String,
  enabled: Schema.Boolean,
  overageLimit: Schema.optionalKey(Schema.Int),
  skipOverageBilling: Schema.optionalKey(Schema.Boolean),
});

export type CustomerSpendLimit = typeof CustomerSpendLimit.Type;

/** The controls a customer carries over the plan defaults. */
export const BillingControls = Schema.Struct({
  autoTopUps: Schema.optionalKey(Schema.Array(CustomerAutoTopUp)),
  spendLimits: Schema.optionalKey(Schema.Array(CustomerSpendLimit)),
});

export type BillingControls = typeof BillingControls.Type;

/** What a customer is, before its balances are folded in. */
export const Customer = Schema.Struct({
  id: CustomerId,
  name: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  plans: Schema.Array(CustomerPlan),
  billingControls: Schema.optionalKey(BillingControls),
});

export type Customer = typeof Customer.Type;
