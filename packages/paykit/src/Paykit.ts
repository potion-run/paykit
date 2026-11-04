import { allowance } from "./Allowance.ts";
import { BillingAdminApi } from "./BillingAdminApi.api.ts";
import { BillingApi } from "./BillingApi.api.ts";
import { providers } from "./BillingStack.resource.ts";
import { catalog, defineCatalog } from "./Catalog.ts";
import { CatalogGuardLive } from "./CatalogGuard.ts";
import { Check, CheckHttp, CheckInProcess, CheckReadModel, evaluateCheck } from "./Check.ts";
import { doctor } from "./Doctor.ts";
import { feature } from "./Feature.ts";
import { Release, Reserve, Settle } from "./Hold.ts";
import { List } from "./List.ts";
import { PaykitHandlers, PaykitModel } from "./Paykit.model.ts";
import { PaymentsManual } from "./PaymentsManual.ts";
import { PaymentsMemory } from "./PaymentsMemory.ts";
import { PaymentsPolar } from "./PaymentsPolar.ts";
import { PaymentsStripe } from "./PaymentsStripe.ts";
import { Portal } from "./Portal.ts";
import { Preview } from "./Preview.ts";
import { MemoryStore, Postgres, Sqlite, Stack } from "./Stack.ts";
import { SqlAggregateStore } from "./Store/SqlAggregateStore.ts";
import { layerSqlPlatform, SqlPlatform } from "./Store/SqlPlatform.ts";
import { Subscribe } from "./Subscribe.ts";
import { tier } from "./Tier.ts";
import { Track } from "./Track.ts";
import { Verify, verifyState } from "./Verify.ts";
import { completeCheckout, handleWebhook } from "./Webhooks.ts";

/**
 * The four export groups as one namespace, so the docs' `Paykit.feature(...)`
 * and the flat named exports are the same functions. Nothing here is a second
 * implementation; it is a reading order.
 *
 * ### Declaring and selling
 * **Example:** A catalog, a Stack, and a purchase
 * ```typescript
 * const messages = Paykit.feature({ id: "messages", name: "Messages" });
 * const free = Paykit.tier({
 *   id: "free",
 *   grants: [Paykit.allowance(messages, { included: 100 })],
 * });
 * const pro = Paykit.tier({
 *   id: "pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [Paykit.allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * const billing = yield* Paykit.Stack("Billing", {
 *   store: Paykit.MemoryStore(),
 *   providers: [Paykit.Manual()],
 *   catalog: { features: [messages], tiers: [free, pro] },
 * });
 *
 * const subscribe = yield* Paykit.Subscribe();
 * yield* subscribe({ account, tier: "pro" });
 * ```
 *
 * @primitive
 */
export const Paykit = {
  // deploy-time
  feature,
  allowance,
  tier,
  catalog,
  defineCatalog,
  CatalogGuard: CatalogGuardLive,
  Stack,
  providers,
  MemoryStore,
  Postgres,
  Sqlite,
  SqlAggregateStore,
  SqlPlatform,
  layerSqlPlatform,
  // runtime
  Check,
  CheckInProcess,
  CheckReadModel,
  CheckHttp,
  evaluateCheck,
  Track,
  Reserve,
  Settle,
  Release,
  Subscribe,
  Portal,
  List,
  Preview,
  Verify,
  verifyState,
  doctor,
  handleWebhook,
  completeCheckout,
  // model
  Model: PaykitModel,
  ModelHandlers: PaykitHandlers,
  BillingApi,
  BillingAdminApi,
  // providers
  Memory: PaymentsMemory,
  Manual: PaymentsManual,
  Stripe: PaymentsStripe,
  Polar: PaymentsPolar,
} as const;
