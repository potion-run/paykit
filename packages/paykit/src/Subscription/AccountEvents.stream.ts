import * as Domain from "@alchemy.run/domain";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Every event for one account, in order: the audit pane, support, and the
 * source a projection appends to. Read it through an Api; a view is for
 * numbers, not for a log.
 */
export class AccountEvents extends Domain.Stream("AccountEvents", {
  key: Subscription,
  entries: Subscription.definition.events,
}) {}
