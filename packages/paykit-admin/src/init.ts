import { BillingReadPage } from "@potion.run/paykit/BillingReadStore";
import { Catalog } from "@potion.run/paykit/Catalog";
import { AdminQueries } from "@potion.run/paykit/Foldkit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import type { Runtime } from "foldkit";
import { Flags } from "./Flags.ts";
import { Message } from "./Message.ts";
import { Model } from "./Model.ts";
import type { ConsoleResources } from "./Requirements.ts";

/**
 * Seed the first paint from Flags, then ask for whatever the host did not
 * seed. A stale snapshot falls back to a live read; it never blocks boot.
 */
export const init: Runtime.ApplicationInit<Model, Message, Flags, ConsoleResources> = (flags) => {
  const catalog = Option.getOrNull(Schema.decodeUnknownOption(Catalog)(flags.catalog));
  const page = Option.getOrNull(Schema.decodeUnknownOption(BillingReadPage)(flags.accounts));
  const commands: Array<Command.Command<Message, never, ConsoleResources>> = [];
  let sent = 0;

  if (catalog === null) {
    commands.push(
      Command.mapMessage(AdminQueries.Catalog({ requestId: sent++ }), (message) =>
        Message.ReceivedAdminQuery({ message }),
      ),
    );
  }

  const listRequest = page === null ? sent++ : null;
  if (listRequest !== null) {
    commands.push(
      Command.mapMessage(
        AdminQueries.ListAccounts({ requestId: listRequest, query: {} }),
        (message) => Message.ReceivedAdminQuery({ message }),
      ),
    );
  }

  const model = Model.make({
    session: flags.session,
    actor: Option.fromNullishOr(flags.actor),
    commandIds: { session: flags.session, sent: 0 },
    queryIds: { sent },
    catalog: Option.fromNullishOr(catalog),
    catalogError: Option.none(),
    accounts: {
      rows: page?.rows ?? [],
      next: Option.fromNullishOr(page?.next ?? null),
      filter: {
        standing: Option.none(),
        status: Option.none(),
        tier: Option.none(),
      },
      state: page !== null ? "Loaded" : "Loading",
      error: Option.none(),
      requestId: Option.fromNullishOr(listRequest),
    },
    account: Option.none(),
  });

  return commands.length === 0 ? { model } : { model, commands };
};
