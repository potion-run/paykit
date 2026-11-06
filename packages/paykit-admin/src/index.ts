import type { Runtime } from "foldkit";
import { Flags } from "./Flags.ts";
import { init } from "./init.ts";
import { Message } from "./Message.ts";
import { Model } from "./Model.ts";
import { subscriptions } from "./subscriptions.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

/**
 * The routing config a host hands to `Runtime.makeApplication`: a URL change
 * (a push, a replace, a back button) becomes `ChangedUrl`, and a link click
 * becomes `ClickedLink`. It must be spread in with the rest of the program, or
 * the address bar and the Model drift apart.
 */
export const routing: Runtime.RoutingConfig<Message> = {
  onUrlRequest: (request) => Message.ClickedLink({ request }),
  onUrlChange: (url) => Message.ChangedUrl({ url }),
};

/**
 * The console program. Spread it into `Runtime.makeApplication` with `routing`
 * and provide the Api client and `AdminReads` as resources:
 *
 * ```typescript
 * Runtime.run(
 *   Runtime.makeApplication({
 *     ...Console,
 *     resources,
 *     container: document.getElementById("root"),
 *   }),
 *   { flags: Console.Flags.make({ session: crypto.randomUUID() }) },
 * );
 * ```
 *
 * The program never owns billing state: `BillingAdmin` commands are the only
 * writes, and `Entitlements`, `BillingState` and `AccountEvents` are the live
 * reads. What it does own is where you are: the route in the address bar names
 * the account and the filters, and `init` boots the same view from it.
 */
export interface ConsoleProgram {
  readonly Flags: typeof Flags;
  readonly Model: typeof Model;
  readonly Message: typeof Message;
  readonly init: typeof init;
  readonly update: typeof update;
  readonly subscriptions: typeof subscriptions;
  readonly routing: typeof routing;
  readonly view: typeof view;
}

export const Console: ConsoleProgram = {
  Flags,
  Model,
  Message,
  init,
  update,
  subscriptions,
  routing,
  view,
};

export { Flags, init, Model, Message, subscriptions, update, view };
export { formatDateTime, formatMoney } from "./format.ts";
export {
  AccountFilter,
  accountRoute,
  accountsRoute,
  afterOf,
  ConsoleRoute,
  filterOf,
  noFilter,
  reflectRoute,
  routeOf,
  withAfter,
  withFilter,
} from "./Route.ts";
export { AccountSnapshot, decodeSnapshotFlags } from "./Snapshot.ts";
export {
  DevToolsEvent,
  DevToolsState,
  DevToolsTab,
  devToolsEvents,
  devToolsTabs,
  initialDevToolsState,
  subscriptionEventTags,
} from "./DevTools.ts";
export type {
  AccountState,
  ActionDraft,
  AdminFailure,
  AdminIntent,
  AnswerState,
  EventRow,
  HoldsState,
  Pending,
  OverviewState,
  PreviewState,
  ProviderRefsState,
  VerifyState,
} from "./Model.ts";
