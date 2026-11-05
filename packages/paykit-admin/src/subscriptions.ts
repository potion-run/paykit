import { BillingAdmin } from "@potion.run/paykit/Foldkit";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import * as Option from "effect/Option";
import { Subscription } from "foldkit";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import type { ConsoleResources } from "./Requirements.ts";

const emptyAccount = AccountId.make("");

const eventBody = (event: unknown): string => {
  try {
    return JSON.stringify(event);
  } catch {
    return "{}";
  }
};

const key = (model: Model): AccountId =>
  Option.getOrElse(
    Option.map(model.account, (account) => account.id),
    () => emptyAccount,
  );

/**
 * Live reads for the open account. The list, preview and verify are Commands,
 * not subscriptions: they answer a question once, and a list is not a keyed
 * view.
 */
export const subscriptions: Subscription.Subscriptions<Model, Message, ConsoleResources> =
  Subscription.make<Model, Message, ConsoleResources>()(() => ({
    billing: BillingAdmin.BillingState.watch({
      key,
      isEnabled: (model) => Option.isSome(model.account),
      toMessage: ({ state }): Message => Message.ReceivedBilling({ state }),
      onFailure: (error): Message => Message.FailedAccountWatch({ reason: error._tag }),
      onDefect: (): Message => Message.FailedAccountWatch({ reason: "Read defect" }),
    }),

    entitlements: BillingAdmin.Entitlements.watch({
      key,
      isEnabled: (model) => Option.isSome(model.account),
      toMessage: ({ state }): Message => Message.ReceivedEntitlements({ state }),
      onFailure: (error): Message => Message.FailedAccountWatch({ reason: error._tag }),
      onDefect: (): Message => Message.FailedAccountWatch({ reason: "Read defect" }),
    }),

    events: BillingAdmin.AccountEvents.events({
      key,
      cursor: (model) => Option.flatMap(model.account, (account) => account.cursor),
      isEnabled: (model) => Option.isSome(model.account),
      onEntry: ({ event, envelope }): Message =>
        Message.ReceivedEvent({
          seq: envelope.seq,
          at: envelope.at,
          commandId: envelope.commandId,
          tag: event._tag,
          body: eventBody(event),
        }),
      onCaughtUp: (cursor): Message => Message.CaughtUpEvents({ cursor }),
      onFailure: (error): Message => Message.FailedEvents({ reason: error._tag }),
      onDefect: (): Message => Message.FailedEvents({ reason: "Read defect" }),
    }),
  }));
