import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { Proration as ProrationValue } from "../Proration.ts";
import { Price } from "../Tier.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";

/** A tier change would leave usage above the new tier's included amount. */
export class DowngradeBelowUsage extends Domain.Rejection("DowngradeBelowUsage", {
  feature: Schema.String,
  included: Schema.Int,
  used: Schema.Int,
}) {}

/** The account is now on another tier; any proration is carried for audit. */
export class TierChanged extends Domain.Event("TierChanged", {
  tier: Schema.String,
  allowances: Allowances,
  remaining: Schema.Record(Schema.String, Schema.Int),
  currency: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Literals(["month", "annual"])),
  proration: Schema.optionalKey(ProrationValue),
}) {}

/** Move an existing standing to another tier. */
export class ChangeTier extends Domain.Command("ChangeTier", {
  target: AccountId,
  input: {
    tier: Schema.String,
    allowances: Allowances,
    price: Schema.optionalKey(Price),
    proration: Schema.optionalKey(ProrationValue),
  },
  events: [TierChanged],
  rejects: [TierNotInCatalog, NotSubscribed, CurrencyMismatch, DowngradeBelowUsage],
}) {}
