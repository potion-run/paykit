import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The balance is smaller than the amount asked for. */
export class CreditExceedsBalance extends Domain.Rejection("CreditExceedsBalance", {
  balance: Schema.Int,
  requested: Schema.Int,
  /** Credits open holds reserved; `balance - reserved` is what could be spent. */
  reserved: Schema.optionalKey(Schema.Int),
}) {}

/** Account credit was spent. */
export class CreditsConsumed extends Domain.Event("CreditsConsumed", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}

/** Spend account credit. The reply is the new balance. */
export class ConsumeCredits extends Domain.Command("ConsumeCredits", {
  target: AccountId,
  input: { amount: Schema.Int },
  events: [CreditsConsumed],
  rejects: [NotSubscribed, CreditExceedsBalance],
  reply: { balance: Schema.Int },
  middleware: [Session],
}) {}
