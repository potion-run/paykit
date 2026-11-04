import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Price } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/** The account's standing was activated for a tier, with a fresh period. */
export class SubscriptionActivated extends Domain.Event("SubscriptionActivated", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.Int),
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  anchorTz: Schema.String,
  interval: Schema.Literals(["month", "annual"]),
  currency: Schema.optionalKey(Schema.String),
  statusAfter: Schema.Literal("active"),
}) {}

/** Activate a standing for a tier. Provider checkout owns the money side. */
export class Subscribe extends Domain.Command("Subscribe", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    anchorTz: Schema.optionalKey(Schema.String),
  },
  events: [SubscriptionActivated],
  rejects: [TierNotInCatalog, CurrencyMismatch],
}) {}
