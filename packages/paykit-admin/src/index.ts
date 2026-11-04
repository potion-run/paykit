import { Flags } from "./Flags.ts";
import { init } from "./init.ts";
import { Message } from "./Message.ts";
import { Model } from "./Model.ts";
import { subscriptions } from "./subscriptions.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

/**
 * The console program. Spread it into `Runtime.makeApplication` and provide
 * the Api client and `AdminReads` as resources:
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
 * reads.
 */
export interface ConsoleProgram {
  readonly Flags: typeof Flags;
  readonly Model: typeof Model;
  readonly init: typeof init;
  readonly update: typeof update;
  readonly subscriptions: typeof subscriptions;
  readonly view: typeof view;
}

export const Console: ConsoleProgram = { Flags, Model, init, update, subscriptions, view };

export { Flags, init, Model, Message, subscriptions, update, view };
export { formatDateTime, formatMoney } from "./format.ts";
export type {
  AccountFilter,
  AccountState,
  ActionDraft,
  AdminIntent,
  EventRow,
  Pending,
} from "./Model.ts";
