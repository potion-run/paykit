# 0015 — A runtime binding names a command, and the account is its scope

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0004](./0004-a-hold-is-one-call-and-an-id.md)
- **Supersedes:** the `Track` / `Hold` / `Settle` / `Release` / `CheckInProcess` / `CheckReadModel` /
  `CheckHttp` surface

## Context

The runtime surface grew one function at a time, and each function is its own dialect. `Track`,
`Hold`, `Settle` and `Release` are `Effect.fn`s that resolve their services where they are called and
take the account as a field of the payload. `Check` is three functions over three transports plus a
`CheckTransport` service. `Subscribe` joins the catalog; `Preview` takes a bare `{ kind }`; `List`
takes a page. Nothing is wrong with any of them alone, and the combination has four problems:

**The account is a payload field.** Every write is `binding({ account, ... })`, so a call site that
was handed the wrong account id writes to the wrong account, and the type system has nothing to say
about it. The `Session` guard catches the actor mismatch at the Api, not at the binding.

**The transport is baked in.** `Check` needed three exports to say "here, the read model, or over
HTTP", and only `Check` got that treatment. A service that hosts the model in one Worker and reads it
from another cannot swap anything else.

**There is no tag to provide.** An `Effect.fn` resolves `Subscription` and `Entitlements` from the
context of its caller, so every call site carries the model's requirements, and no deployment can
substitute a different implementation of one verb. Alchemy's Stripe package solves this with
`Binding.Service` — one identifier that is the Context tag, the type and the callable — and
`…Http` layers beside each one.

**Two spellings for one operation.** `Track` versus `TrackUsage`, `Settle` versus `SettleHold`,
`Paykit.Check` versus the `Check` read path. The MCP tools and CLI are derived from the command
names, so an SDK verb that is spelled differently means a developer, an agent and an operator read
three words for one thing.

An ergonomic alternative was considered and rejected: one `Billing` handle, `billing.for(account)`,
with friendly verbs (`can`, `use`, `hold`). It reads well, and it fails on clearance — a handle needs
one layer, so the tenant handle's layer would carry the admin commands' clearance too — and it
re-introduces the second spelling this decision exists to remove.

## Decision

**1. One binding per command, named for the command.** `Paykit.TrackUsage`, `Paykit.SettleHold`,
`Paykit.ChangeTier`. Not `Track`, not `Settle`, not `use`. The name in the SDK, in `BillingApi`, in
the MCP tool list and in the CLI is one string.

**2. The account is the bind, and the request is the rest — as an encoded id.**
The shape is Alchemy's `(scope) => Effect<(request) => Effect<…>>`, so `TrackUsage(account)` returns
the verb and the verb takes only `{ feature, amount, dimension }`. The bound id is struck from the
request type, the way `RetrievePriceRequest` omits `price`, so a second account is not representable.

The bind takes the **encoded** id — a `string` — and the layer brands it once through
`Subscription.ref(account)`, which is `Domain.Aggregate.ref`: Alchemy's own
`static ref(id: Encoded): Ref<Self>` decodes the plain id to the branded one
(`Aggregate.ts`, `decodeUnknownSync(definition.id)`). The brand belongs inside the domain, where
`decide` and the Api client need it; the boundary takes what the caller has. That is also why a tier
id is a `string` in the request: the binding validates it against the catalog (`planOf` →
`PlanNotInCatalog`), so a brand there would buy nothing and cost every caller a cast.

The rule this replaced was the opposite, and it produced `as never` at forty call sites. `never` is
assignable to everything, so a wrong argument type-checked silently — the cast removed the very check
the brand was there to make. A brand at a boundary that has no validator is theatre; a brand at a
boundary whose validator runs is the only place it pays.

**2b. The account stays a value, not a resource.** The shape is Alchemy's
`(scope) => Effect<(request) => Effect<…>>`, so `TrackUsage(account)` returns the verb and the verb
takes only `{ feature, amount, dimension }`. The bound id is struck from the request type, the way
`RetrievePriceRequest` omits `price`, so a second account is not representable. The account stays a
branded `AccountId` and not a resource: an account is application data that outlives the stack
(ADR 0003), so there is nothing for the engine to own.

**3. Configuration rides the layer; identity rides the bind.** The catalog, the store, the providers
and the credentials are provided by a layer, never passed to a verb. This is why `Subscribe` needs no
catalog argument and why a test can provide a catalog the deployment does not have.

**4. Clearance is a layer, and there are two.** `BillingInProcess` / `BillingApi` provide the tenant
commands; `BillingAdminInProcess` / `BillingAdminApi` provide the admin ones. Not one layer per
binding: Alchemy's Stripe package has one layer per operation because each operation has its own
vendor permissions, while paykit's clearance is already partitioned by Api. A tenant layer that
provided `GrantCredits` would be a wider surface than `BillingApi` allows.

**5. A verb's error is paykit's, not the transport's.** A rejection is a refusal the model understood
— the write did not happen. `Domain.ConsistencyTimeout` is the write committed and the read behind it
late. `BindingFailed` is the transport or the decode, so nobody knows. Three outcomes, three tags;
never folded together, because only one of them may be retried as if nothing happened.

**6. A write carries a `dedupeKey`, and it is the command id.** A binding may be retried by its
transport, so the request requires the key rather than accepting it.

**7. Two layers per surface, one for the model and one for the Api.** `TrackUsageInProcess` closes
over the model services; `TrackUsageApi` closes over `BillingApi.Client` and is therefore
protocol-agnostic — the bundle provides `layerClientInProcess` or `layerClientHttp(url)`, and no
binding file changes. Both layers honour read-your-write: the Api layer waits on
`Entitlements.get(account, { atLeast: receipt })`, exactly as the in-process one waits on
`entitlements.query`.

**8. Two kinds of binding, and the difference is whether the model has to be asked.**
A *command* binding's request is the command's input minus the account, so both layers can build it:
`TrackUsage`, `Hold`, `SettleHold`, `ReleaseHold`, `ConsumeCredits`, `ScheduleCancellation`,
`Resume`, `ScheduleTierChange`, `WithdrawTierChange`, `StartTrial`. An *operation* binding needs
something only the process that owns the model has — the standing, a provider, a signature — so it
gets the in-process layer only: `Subscribe` (a checkout path), `ChangeTier` (a proration computed from
the standing), `Preview`, `Portal`, `Webhook`, `ChargeProration`, `List`. An operation is not a
degraded command; it is work the Api does not serve, and a remote deployment exposes it on its own
route. `ChangeTier` is the clearest case: a mid-cycle upgrade has a proration, the Api client has no
standing to compute it from, and a payload without it is refused with `ProrationMismatch`. Hiding
that behind one call that "just works" locally would be a transport-dependent result.

**9. `Check` becomes one binding with three layers.** `CheckInProcess` is the default, `CheckReadModel`
reads one `billing_rm_*` row, `CheckHttp` delegates to `CheckTransport`. The three exported functions
and the transport service stay as layers of one tag.

## Consequences

- Retiring `Track`, `Hold`, `Settle`, `Release` is a breaking change to every call site. The package
  is `0.1.0` and unpublished, so the rename is free now and expensive later; the migration is one
  slice, not a deprecation period with two live spellings.
- A binding is only usable where its layer is provided, so a test provides the layer instead of the
  model. That is the point, and it makes the two transports a parameter of one test body.
- `RuntimeContext`, `Credentials`-style services and the `…Http` layer pattern now have an analogue
  here; a deployment assembles four layers instead of calling twelve functions.

## Slices

**1 — landed.** The usage family, end to end: `TrackUsage`, `Check`, `Hold`, `SettleHold`,
`ReleaseHold`, their two layers (`BillingInProcess`, `BillingApiLayer`) and one test body run against
both — 15 cases, no assertion written twice. The shared scaffolding is `src/Billing/Bindings.ts`
(`BindingFailed`, `BindingCall`, `BindingError`, `oneOf`, `toBindingError`, `mapBindingFailure`,
`callOptions`), and each binding's refusals are one list that yields both the union type and the
guard.

Two things the slice found:

- **`SettleHold` and `ReleaseHold` returned before the read model caught up.** A `Check` straight
  after a settle saw the pre-settle remaining. Both now wait on `Entitlements` with `atLeast` the
  receipt, the same way `TrackUsage` does, so read-your-write is a property of the binding and not of
  one verb.
- **A command's own numbers travel as its `reply`.** `SettleHold` and `ReleaseHold` gained replies
  (`{ billed, released }`, `{ released }`) computed from the events they committed, so the answer is
  the money the log recorded and it survives a transport. `TrackUsage` reads `Entitlements` instead,
  because what a caller needs there is what is left, not what this event billed.

**2 — landed, in part.** `ConsumeCredits`, `ScheduleCancellation`, `Resume` as command bindings on
both layers, and `ChangeTier` as an operation binding reusing `planChangeTier` — the binding joins the
catalog's `planTermsOf` and the standing so a caller writes `{ tier }` and nothing else, which is what
`tierCommand` did by hand in the example. 30 cases in `test/bindings`, still one body per claim.

Three things the slice found:

- **An inputless command takes its options third.** `ScheduleCancellation` and `Resume` have no input,
  so `client.ScheduleCancellation(account, options)` passed the headers as the *input* and the Api
  answered `Unauthenticated`. The call is `(target, {}, options)`.
- **The caller is resolved once, at the edge.** `callOptions` read `BindingCall` inside every verb, so
  the verb's requirements carried a service it did not need. It is `callOptionsOf(option)` resolved in
  the layer now, which is the same rule the rest of the package follows and which keeps a caller of a
  binding from having to know how the binding authenticates.
- **`ChangeTier` cannot be a command binding.** See decision 8.

**2b — landed.** `ScheduleTierChange`, `WithdrawTierChange` and `StartTrial` as command bindings on
both layers — each joins `planTermsOf` in the layer, so a caller names a tier and `CatalogGuard` sees
a payload that agrees with the deploy. `Subscribe` and `Preview` as operation bindings, each
**delegating to the binding that already walks that path** (`subscribeOf()`, `previewOf()`) rather
than re-implementing a purchase or a quote: a layer's job is the tag, the types and the failure
policy, and a second purchase path would be a second answer to "what did we charge".

That delegation is the answer to the operation shape in general: `Portal`, `ChargeProration` and
`List` converted the same way. `List` is also the empty-bind case — `List()` takes no argument at all,
because its scope is the deployment and not an account, the `Stripe.CreateCheckoutSession()` shape.
`Webhook` followed: an empty bind like `List`, taking the *decoded* event, answering an
`WebhookAction`. It is the one binding that does **not** wait for a read model afterwards — it has no
receipt of its own, and a provider needs an answer, not a snapshot. Its failure contract is the edge's
own two judgements (`WebhookInvalid`, `PlanNotInCatalog`); a model rejection that reaches it becomes
`BindingFailed` on purpose, because a delivery paykit could not apply is one the provider should
retry.

The genre is complete: 17 tenant tags, 7 operator tags, four layers.

`ChargeProration` gained a call-site decision the old binding left out: `NoProrationDue` is a
*result* (`{ outcome: "nothing" }`), not a refusal. Asking "collect what you can" should not require
a catch for the common case; the typed refusal stays for the provider ops that really failed.

**On `dedupeKey`, refined.** Decision 6 says a write carries one. An operation whose identity is the
provider's own reference is the exception: `Subscribe` derives
`checkout:<account>:<tier>:<reference>`, so a retry re-derives the same checkout rather than a second
one. The key is required where the model applies the write, and named by the provider where the
provider owns the identity — and the binding's doc says which it is, rather than accepting a key it
would ignore.

**3 — landed, in part.** `src/Billing/index.ts` is the binding barrel — one import for the whole
surface — and `test/bindings/LayerSurface.test.ts` asserts what each layer holds: the in-process
layer provides all 17 tags, the Api layer provides the 11 command bindings and **none** of the 6
operations. That test is the clearance claim, and it fails if someone adds an operation to the wrong
layer.

The barrel is deliberately *not* the package root. `TrackUsage`, `Hold`, `Preview` and friends are
still the names of command classes and of the old bindings, so exporting the tags from the root in the
same commit would put two meanings of one name in one namespace. The root re-pointed in slice 5, when
the old names were deleted.

**3c — landed.** `test/bindings/HttpTransport.test.ts` serves `BillingApi` and drives
`BillingApiLayer` over `layerClientHttp`: the outgoing request becomes a `Request`, the Api's own
`fetch` answers it, and the response becomes a client response, so the `Session` middleware, the
NDJSON framing and the reply decoding all run for real. On that transport the test proves
read-your-write (the binding waited on `Entitlements` over the same Api before answering), a replay
by `dedupeKey`, and an `AllowanceExceeded` decoded back into the class a caller matches. That was the
last claim in this document with no test behind it.

**3b — landed.** The surface has a documented entry point that does not disturb a retiring name:
`Paykit.Billing` (also `export * as Billing` from the package root) is the binding barrel. So
`Paykit.Billing.TrackUsage(account)` works today, `Paykit.Track` keeps working until it is deleted,
and the two never share a key. `test/PublicSurface.test.ts` asserts the namespace, the keys and the
four layers.

**4 — landed.** All four layers now exist: `BillingInProcess` and `BillingApiLayer` for the tenant
surface, `BillingAdminInProcess` and `BillingAdminApiLayer` for the operator one. The seven admin
bindings (`GrantCredits`, `ExtendTrial`, `EnterGrace`, `Recover`, `Expire`, `RecordPayment`,
`RecordPaymentFailure`) live on the admin layers only, and `test/bindings/AdminBindings.test.ts`
asserts both directions: each admin layer provides all seven, and **neither** tenant layer provides
any of them — in process and over an Api. That negative test is the clearance claim in decision 4,
made executable.

Two things the slice settled:

- **An admin verb answers the standing, not its events.** `BillingState` is read with `atLeast` the
  receipt and mapped by one `standingSnapshot`, so every operator verb answers the same shape a
  console renders — and `GrantCredits` still answers the `{ balance }` its reply recorded, because
  that is the number the log committed.
- **Recording a payment *is* recovery.** `RecordPayment` requires grace and ends it in the same
  command, so `Recover` afterwards is `NotInGrace`. The test says so explicitly, because a console
  that offers both buttons needs to know they are not sequential.

**5.** Retire `Track` / `Hold` / `Settle` / `Release` / `CheckInProcess` / `CheckReadModel` /
`CheckHttp` across `packages/` and `examples/` (68 call sites), then the transport conformance suite.
The new bindings are reachable by path until then; they are not exported while two spellings of one
command exist.
