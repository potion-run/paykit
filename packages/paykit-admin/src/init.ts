import { AdminQueries } from "@potion.run/paykit/Foldkit";
import { initialTimeline } from "@potion.run/paykit/Timeline";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import type { Runtime } from "foldkit";
import type { Url } from "foldkit/url";
import { initialDevToolsState } from "./DevTools.ts";
import { Flags } from "./Flags.ts";
import { Message } from "./Message.ts";
import { HoldsState, Model, openedAccount } from "./Model.ts";
import type { ConsoleResources } from "./Requirements.ts";
import { afterOf, filterOf, queryOf, routeOf } from "./Route.ts";
import { decodeSnapshotFlags } from "./Snapshot.ts";

/**
 * Seed the first paint from the URL and Flags, then ask for whatever the host
 * did not seed. The route decides what is on screen — the account, the filters
 * — so a refresh, a shared link and a back button all boot the same view. A
 * stale snapshot falls back to a live read; it never blocks boot.
 */
export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, ConsoleResources> = (
  flags,
  url: Url,
) => {
  const snapshots = decodeSnapshotFlags(flags);
  const route = routeOf(url);
  const filter = filterOf(route);
  const after = Option.getOrUndefined(afterOf(route));
  const catalog = Option.getOrNull(snapshots.catalog);
  const page = Option.getOrNull(snapshots.accounts);
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
        AdminQueries.ListAccounts({ requestId: listRequest, query: queryOf(filter, after) }),
        (message) => Message.ReceivedAdminQuery({ message }),
      ),
    );
  }

  // Holds are not part of the first-paint snapshot: the host seeds the two
  // views and the cursor, and the entities are read once at boot.
  const holdsRequest = route._tag === "Account" ? sent++ : null;
  if (holdsRequest !== null && route._tag === "Account") {
    commands.push(
      Command.mapMessage(
        AdminQueries.Holds({ requestId: holdsRequest, account: route.account }),
        (message) => Message.ReceivedAdminQuery({ message }),
      ),
    );
  }

  const snapshot =
    route._tag === "Account" &&
    Option.isSome(snapshots.account) &&
    snapshots.account.value.account === route.account
      ? snapshots.account.value
      : null;

  const account =
    route._tag === "Account"
      ? Option.some({
          ...openedAccount(route.account),
          billing: Option.fromNullishOr(snapshot?.billing),
          entitlements: Option.fromNullishOr(snapshot?.entitlements),
          timeline: snapshot?.timeline ?? initialTimeline,
          cursor: Option.fromNullishOr(snapshot?.cursor),
          holds:
            holdsRequest === null
              ? Option.none()
              : Option.some(
                  HoldsState.make({
                    requestId: holdsRequest,
                    account: route.account,
                    state: "Loading",
                    asOf: Option.none(),
                    holds: [],
                    error: Option.none(),
                  }),
                ),
        })
      : Option.none();

  const model = Model.make({
    session: flags.session,
    actor: Option.fromNullishOr(flags.actor),
    commandIds: { session: flags.session, sent: 0 },
    queryIds: { sent },
    catalog: Option.fromNullishOr(catalog),
    catalogError: Option.none(),
    devTools: initialDevToolsState(flags.devTools === true),
    route,
    accounts: {
      rows: page?.rows ?? [],
      next: Option.fromNullishOr(page?.next ?? null),
      filter,
      state: page !== null ? "Loaded" : "Loading",
      error: Option.none(),
      requestId: Option.fromNullishOr(listRequest),
      // The seeded page carries the time the host read it; a hand-built page
      // carries none, and the console says so rather than inventing one.
      asOf: Option.fromNullishOr(page?.asOf),
    },
    account,
  });

  return commands.length === 0 ? { model } : { model, commands };
};
