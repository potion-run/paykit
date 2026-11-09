import { grant } from "./Allowance.ts";
import { account as actorAccount, admin as actorAdmin, mayActOn } from "./Auth/Actor.ts";
import { InsecureDevGuards } from "./Auth/FromHeaders.ts";
import { AdminFrom, GuardsFrom, SessionFrom, authenticate } from "./Auth/FromResolver.ts";
import * as Billing from "./Billing/index.ts";
import { BillingAdminApi } from "./BillingAdminApi.api.ts";
import { BillingApi } from "./BillingApi.api.ts";
import { providers } from "./BillingStack.resource.ts";
import { BillingStack as BillingStackDeploy } from "./BillingStack.ts";
import { planItemsOf, planOf } from "./Catalog.ts";
import { catalog, defineCatalog } from "./Catalog.ts";
import { CatalogGuardLive } from "./CatalogGuard.ts";
import { evaluateCheck } from "./Check.ts";
import { doctor } from "./Doctor.ts";
import { feature } from "./Feature.ts";
import { handler, moneyRoutes } from "./Handler.ts";
import { httpStatus } from "./HttpStatus.ts";
import { PaykitHandlers, PaykitModel } from "./Paykit.model.ts";
import { paymentsRouter } from "./Payments.ts";
import { PaymentsManual } from "./PaymentsManual.ts";
import { PaymentsMemory } from "./PaymentsMemory.ts";
import { PaymentsPolar } from "./PaymentsPolar.ts";
import { PaymentsStripe } from "./PaymentsStripe.ts";
import { plan } from "./Plan.ts";
import { planItem, prorationOf, resetOf, rolloverOf } from "./PlanItem.ts";
import { MemoryStore, Postgres, Sqlite, validateStack } from "./Stack.ts";
import { d1Executor } from "./Store/D1.ts";
import { SqlAggregateStore } from "./Store/SqlAggregateStore.ts";
import { SqlBillingReadStore } from "./Store/SqlBillingReadStore.ts";
import { layerSqlPlatform, SqlPlatform } from "./Store/SqlPlatform.ts";
import { autoTopUp } from "./Subscription/AutoTopUp.policy.ts";
import { Dunning, dunning } from "./Subscription/Dunning.policy.ts";
import { PeriodCloseUsage } from "./Subscription/PeriodCloseUsage.policy.ts";
import { PlanTrial } from "./Tier.ts";
import { appendTimeline, initialTimeline, timelineOf } from "./Timeline.ts";
import { Verify, verifyState } from "./Verify.ts";
import { world } from "./World.ts";

/**
 * The four export groups as one namespace, so the docs' `Paykit.feature(...)`
 * and the flat named exports are the same functions. Nothing here is a second
 * implementation; it is a reading order.
 *
 * Every runtime verb is a binding named for its command: `Paykit.TrackUsage(account)`
 * returns the verb, and the verb takes the rest.
 *
 * ### Declaring and selling
 * **Example:** A catalog, a Stack, and a purchase
 * ```typescript
 * const messages = Paykit.feature({ id: "messages", name: "Messages" });
 * const free = Paykit.plan({
 *   id: "free",
 *   grants: [Paykit.planItem(messages, { included: 100 })],
 * });
 * const pro = Paykit.plan({
 *   id: "pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * const billing = yield* Paykit.BillingStack("Billing", {
 *   store: Paykit.MemoryStore(),
 *   providers: [Paykit.Manual()],
 *   catalog: { features: [messages], tiers: [free, pro] },
 * });
 *
 * const subscribe = yield* Paykit.Subscribe(account);
 * yield* subscribe({ tier: "pro" });
 * ```
 *
 * @primitive
 */
export const Paykit = {
  // deploy-time
  feature,
  grant,
  plan,
  planItem,
  resetOf,
  prorationOf,
  rolloverOf,
  planOf,
  planItemsOf,
  PlanTrial,
  catalog,
  defineCatalog,
  CatalogGuard: CatalogGuardLive,
  BillingStack: BillingStackDeploy,
  validateStack,
  world,
  providers,
  MemoryStore,
  Postgres,
  Sqlite,
  SqlAggregateStore,
  SqlPlatform,
  layerSqlPlatform,
  SqlBillingReadStore,
  d1Executor,
  // runtime — the tenant surface, one binding per command
  Attach: Billing.Attach,
  Update: Billing.Update,
  AddAddOn: Billing.AddAddOn,
  MultiAttach: Billing.MultiAttach,
  MultiUpdate: Billing.MultiUpdate,
  PreviewAttach: Billing.PreviewAttach,
  PreviewUpdate: Billing.PreviewUpdate,
  Check: Billing.Check,
  CheckReadModel: Billing.CheckReadModel,
  CheckOverTransport: Billing.CheckOverTransport,
  TrackUsage: Billing.TrackUsage,
  Balances: Billing.Balances,
  Customers: Billing.Customers,
  CreateCustomer: Billing.CreateCustomer,
  Entities: Billing.Entities,
  TransferBalance: Billing.TransferBalance,
  SetBillingControls: Billing.SetBillingControls,
  GrantBalance: Billing.GrantBalance,
  SetQuantity: Billing.SetQuantity,
  SetUsage: Billing.SetUsage,
  Hold: Billing.Hold,
  SettleHold: Billing.SettleHold,
  ReleaseHold: Billing.ReleaseHold,
  ConsumeCredits: Billing.ConsumeCredits,
  Subscribe: Billing.Subscribe,
  ChangeTier: Billing.ChangeTier,
  ScheduleTierChange: Billing.ScheduleTierChange,
  WithdrawTierChange: Billing.WithdrawTierChange,
  ScheduleCancellation: Billing.ScheduleCancellation,
  Resume: Billing.Resume,
  StartTrial: Billing.StartTrial,
  Preview: Billing.Preview,
  Portal: Billing.Portal,
  ChargeProration: Billing.ChargeProration,
  ChargeQuantityProration: Billing.ChargeQuantityProration,
  List: Billing.List,
  Webhook: Billing.Webhook,
  evaluateCheck,
  httpStatus,
  // the request handler, and the two money paths it mounts
  handler,
  moneyRoutes,
  timelineOf,
  appendTimeline,
  initialTimeline,
  Verify,
  verifyState,
  doctor,
  // auth — one resolver per deployment, the two guards, and the same resolver
  // for a route that is not an Api
  SessionFrom,
  AdminFrom,
  GuardsFrom,
  authenticate,
  InsecureDevGuards,
  mayActOn,
  actorAccount,
  actorAdmin,
  // runtime — the four layers
  BillingInProcess: Billing.BillingInProcess,
  BillingApiLayer: Billing.BillingApiLayer,
  BillingCommands: Billing.BillingCommands,
  BillingCommandsClient: Billing.BillingCommandsClient,
  BillingCommandsLive: Billing.BillingCommandsLive,
  BillingCommandsServer: Billing.BillingCommandsServer,
  BalancesLive: Billing.BalancesLive,
  CustomersLive: Billing.CustomersLive,
  EntitiesLive: Billing.EntitiesLive,
  TransferBalanceLive: Billing.TransferBalanceLive,
  BillingAdminInProcess: Billing.BillingAdminInProcess,
  BillingAdminApiLayer: Billing.BillingAdminApiLayer,
  // runtime — the operator surface
  GrantCredits: Billing.GrantCredits,
  ExtendTrial: Billing.ExtendTrial,
  EnterGrace: Billing.EnterGrace,
  Recover: Billing.Recover,
  Expire: Billing.Expire,
  RecordPayment: Billing.RecordPayment,
  RecordPaymentFailure: Billing.RecordPaymentFailure,
  Refund: Billing.Refund,
  // the whole binding surface under one key, for a reader who wants it grouped
  Billing,
  // model
  Model: PaykitModel,
  ModelHandlers: PaykitHandlers,
  autoTopUp,
  dunning,
  Dunning,
  PeriodCloseUsage,
  BillingApi,
  BillingAdminApi,
  // providers
  Memory: PaymentsMemory,
  Manual: PaymentsManual,
  Stripe: PaymentsStripe,
  PaymentsPolar,
  paymentsRouter,
} as const;
