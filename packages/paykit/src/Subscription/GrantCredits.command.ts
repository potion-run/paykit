import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** Account credit was added, e.g. an intro grant or a service recovery. */
export class CreditsGranted extends Domain.Event("CreditsGranted", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}

/** Add account credit. The reply is the new balance. */
export class GrantCredits extends Domain.Command("GrantCredits", {
  target: AccountId,
  input: { amount: Schema.Int },
  events: [CreditsGranted],
  rejects: [NotSubscribed],
  reply: { balance: Schema.Int },
  middleware: [Admin],
}) {}
