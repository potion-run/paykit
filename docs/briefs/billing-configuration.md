# Billing configuration: one declaration, three derived surfaces

- **Status:** Accepted (implemented)
- **Follows:** [0001](../adr/0001-catalog-states-the-pricing-model.md),
  [0003](../adr/0003-the-deploy-provisions-the-vendor.md),
  [0015](../adr/0015-a-runtime-binding-names-a-command.md)
- **Touches:** `packages/paykit`, `packages/paykit-stripe`, `packages/paykit-polar`,
  `packages/paykit-admin`, every `examples/*`
- **Landed:** `Paykit.BillingStack`, `Paykit.world`, `PaykitAtom.make({ url, catalog })`,
  `Paykit.httpStatus`, the constructor unions, and `StripeBilling`. The examples read one
  `billing.config.ts`.

## Context

The model is right and the configuration around it is not. A deployment repeats the same catalog in
four places, declares the billing stack twice, and hand-builds a layer merge that the package could
build itself. The repetition is not incidental: it is where a catalog drifts from the deploy, where
a provider descriptor leaks, and where a `CatalogError` becomes a module-load crash.

### What the TanStack example wrote before this change

`examples/tanstack/src/Billing.ts`:

```ts
export const Catalog = Effect.runSync(catalog(tanstackCatalog));

export const Provider: MoneyProvider = Manual();

export const billingLayers = <R = never>(platform?: PaykitWorldOptions<R>["platform"]) =>
  paykitWorld({
    catalog: Catalog,
    guards: DevGuards,
    providers: [Provider],
    bindings: "tenant",
    ...(platform === undefined ? {} : { platform }),
  });

export const BillingLayers = billingLayers();
export const BillingTestLive = BillingLayers;
```

`examples/tanstack/alchemy.run.ts`:

```ts
const billing = yield* Paykit.Stack("Billing", {
  store: Paykit.MemoryStore(),
  providers: [Paykit.Manual()],
  catalog: tanstackCatalog,
}).pipe(Effect.orDie);

const recorded = yield* BillingStackResource("Billing", {
  catalog: billing.catalog,
  providers: billing.providers.map(providerDescriptor),
  store: billing.store,
});
```

`examples/tanstack/src/billing.atoms.ts`:

```ts
export const Catalog = Effect.runSync(catalog(tanstackCatalog));

export const billing = PaykitAtom.make({
  layer: Layer.mergeAll(
    catalogLayer(Catalog),
    BillingApi.layerClientHttp("/api/billing").pipe(Layer.provide(FetchHttpClient.layer)),
  ),
});
```

`examples/billing` and `examples/auth` add a fifth thing: a `tierCommand` helper that joins the
catalog into a `SubscribeInput` by hand, even though every binding already accepts `{ tier }` and
joins the terms itself (`Subscribe.binding.ts`, `BillingInProcess.layer.ts`). The helper is only
used by tests that send model commands directly; no user needs it.

### The five costs

1. **Two deploy calls, one declaration.** `Paykit.Stack` validates and returns a value; a second
   `BillingStackResource` call records it. The user maps `providers` to `providerDescriptor` and
   passes the same id twice. `providerDescriptor` is an internal serialization detail in the public
   API.
2. **The catalog is validated three times, and the browser holds a second runtime copy.** Once at
   deploy, once in the Worker module with `Effect.runSync`, once in the browser module with
   `Effect.runSync`. The last two crash at import instead of failing in a typed channel, and the
   browser copy can drift from the deploy's.
3. **The world is assembled by hand, with a generic and a spread.** Every example writes
   `billingLayers<R>(platform?)`, spreads an optional `platform`, and names
   `PaykitWorldOptions<R>["platform"]` to get the type. The generic is not the user's concern.
4. **The client is a layer merge.** `catalogLayer` + `BillingApi.layerClientHttp` +
   `FetchHttpClient.layer` is three imports for the common browser case.
5. **The HTTP edge is copied per example.** `statusOf` maps `_tag` to a status in three examples;
   the route skeleton (`/api`, `/admin`, `/checkout`, `/webhooks`) is copied four times.

## What Alchemy already answers

The Alchemy Stripe module is the closest precedent, and the rules are already in the root
[AGENTS.md](../../AGENTS.md#alchemy-api-conventions) and
[Alchemy's own AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md).

- **`StripePrices(id, { tiers })` is an Effect function, not a resource.** It yields
  `Stripe.Product`, `Stripe.Price`, `Stripe.BillingMeter` resources inside, then returns a plain
  value (`SoldPrices`) the runtime can carry. The resource owns state; the value is the handoff.
- **`Stripe(props)` is one call for the provider.** It builds the client, the tier mapping and the
  webhook decoder, and returns a `MoneyProvider` the stack can validate. The user does not assemble
  a `Payments` layer.
- **`Stripe.providers()` is merged once, at `Alchemy.Stack`.** A resource with no provider layer
  cannot reconcile; that is the engine's error, not a second config file.
- **Props are plain, provider-free data.** `Stripe.Price` takes `product: string | Product`; the
  catalog never carries a `price_…` id. Vendor identity lives in provider config.
- **Pure constructors, one validating Effect.** `priceDeclarations` is pure; `StripePrices` is the
  effectful entry point. The same split applies to `defineCatalog` / `catalog()`.
- **Resources are named for their type.** `Stripe.Product`, not `Stripe.makeProduct`.

### What does not transfer

- **Where the resource is declared.** Stripe resources are yielded inside the Worker that uses them,
  because the vendor object is per-Worker and its id is a runtime binding. `BillingStack` is
  declared at `Alchemy.Stack` because the catalog is deployment-wide and the event log outlives a
  Worker ([ADR 0003](../adr/0003-the-deploy-provisions-the-vendor.md)). The one-call shape
  transfers; the placement does not.
- **Not every vendor object is a resource.** `Feature`, `Tier` and `Allowance` stay `Schema.Struct`
  data validated by `BillingStack`, per [ADR 0001](../adr/0001-catalog-states-the-pricing-model.md).
  Only `BillingStack` has `Diff` / `Read` / `Reconcile` / `Delete`.
- **The name.** `Paykit.Billing` is the binding namespace (`Paykit.Billing.TrackUsage`), so the
  deploy primitive is `Paykit.BillingStack`, the resource's own type name. Renaming the binding
  namespace to free the shorter name is a separate break and buys nothing.
- **`consumeEvents` is a surface, not a config primitive.** Stripe's one-call webhook creates the
  vendor endpoint and dispatches; paykit's vendor packages take a signing secret instead. The
  analogous paykit primitive is the route handler in §6, not a second webhook implementation.

The design below is those rules applied to paykit's three surfaces: the deploy, the runtime, the
client.

## Decision

### 1. `Paykit.BillingStack` is the one deploy call

One call validates the catalog, validates every provider mapping, records the `BillingStack`
resource, and returns the plain values a deploy wants.

```ts
const billing = yield* Paykit.BillingStack("Billing", {
  catalog: billingCatalog,
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
});

// billing.catalog   — the validated Catalog
// billing.tiers     — readonly string[]
// billing.providers — readonly ProviderDescriptor[]
// billing.store     — BillingStore
// billing.resource  — the Alchemy resource, for a caller that wants it
```

`BillingStackProps` takes `MoneyProvider[]`, because that is what a user has. The resource props
take `ProviderDescriptor[]`, because props are persisted (`encodeState`, `State/ResourceState.ts`)
and a `MoneyProvider` carries a `Layer`. The function is the boundary where the runtime value
becomes recorded data — `providerDescriptor` never appears in user code again.

```ts
export interface BillingStackProps {
  readonly catalog: CatalogInput;
  readonly providers?: ReadonlyArray<MoneyProvider>;
  readonly store?: Store;
}

export interface BillingDeployment {
  readonly resource: BillingStackShape;
  readonly catalog: Catalog;
  readonly tiers: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ProviderDescriptor>;
  readonly store: Store;
}

export const BillingStack = Effect.fn("Paykit.BillingStack")(function* (
  id: string,
  props: BillingStackProps,
) {
  const parsed = yield* catalog(props.catalog);
  const providers = props.providers ?? [];
  const descriptors = providers.map(providerDescriptor);
  const invalid = validateProviderMappings(parsed, descriptors);
  if (invalid !== null) return yield* invalid;
  const store = props.store ?? MemoryStore();
  const resource = yield* BillingStackResource(id, {
    catalog: parsed,
    providers: descriptors,
    store: storeKindOf(store),
  });
  return {
    resource,
    catalog: parsed,
    tiers: parsed.tiers.map((tier) => tier.id),
    providers: descriptors,
    store,
  };
});
```

The error channel is the existing union:

```ts
Effect.Effect<
  BillingDeployment,
  CatalogError | CatalogPriceMismatch | NoPurchasePath | ProviderDuplicate
>
```

so `Effect.orDie` at the stack is a choice, not a workaround. `Paykit.Stack` is removed;
`BillingStackResource` stays exported for a caller that already has descriptors, but neither appears
in an example or a quickstart.

### 2. `Paykit.world` takes the catalog, not a pre-validated one

The runtime should not require `Effect.runSync(catalog(...))` at module scope. `world` accepts the
same `CatalogInput` the deploy does and validates it inside the layer, in the layer's error channel.

```ts
export const World = Paykit.world({
  catalog: billingCatalog,
  providers: [Provider],
  guards: InsecureDevGuards,
  bindings: "tenant",
});
```

```ts
export const world = <R = never, B extends PaykitBindings = "tenant">(
  props: PaykitWorldProps<R, B>,
): Layer.Layer<WorldServices<B>, CatalogError, R> =>
  Layer.unwrap(Effect.map(catalog(props.catalog), (parsed) => buildWorld(parsed, props)));
```

- `catalog` is `CatalogInput`; re-decoding a value that is already a `Catalog` is a no-op for the
  schema, so there is no second type to carry.
- `CatalogError` is in the layer's error channel. A Worker does
  `Effect.provide(World).pipe(Effect.orDie)` once, at the boundary; a test that provides the world
  gets a typed failure instead of an import-time throw.
- `R` is inferred from `platform`, `guards`, `readStore` and `payments`. The call site never writes
  `<R>` and never spreads an optional platform.
- `paykitWorld` is removed; `world` is the only name.

The deploy and the runtime now take the same three props (`catalog`, `providers`, `store`) from the
same module. A `billing.config.ts` can export them once:

```ts
// src/billing.config.ts — imported by the stack, the Worker and the client.
export const billing = {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
} satisfies Paykit.BillingStackProps;
```

```ts
// alchemy.run.ts
const recorded = yield* Paykit.BillingStack("Billing", billing);

// src/BillingWorker.ts
const World = Paykit.world({ ...billing, guards: InsecureDevGuards, platform: DomainCloudflare.layerDurableObjects() });

// src/billing.atoms.ts
const atoms = PaykitAtom.make({ ...billing, url: "/api/billing" });
```

The spread is a plain object, not a new abstraction: `BillingStackProps` is already the shape all
three surfaces need. `world` ignores `store` (the runtime store is a layer the host provides), and
`make` ignores it for the same reason.

### 3. `PaykitAtom.make({ url, catalog })` is one call

```ts
export const billing = PaykitAtom.make({
  url: "/api/billing",
  catalog: tanstackCatalog,
});
```

`make` builds the layer the user was merging by hand:

```ts
const layer = Layer.mergeAll(
  catalogLayer(parsed),
  BillingApi.layerClientHttp(props.url).pipe(Layer.provide(props.httpClient ?? FetchHttpClient.layer)),
);
```

- `httpClient?: Layer<HttpClient.HttpClient>` for a deployment that brings its own transport.
- `layer` remains as the escape hatch for the in-process test client and for a caller that already
  has a catalog layer.
- The `{ url, catalog }` form returns `BillingAtoms<CatalogError>`, so a catalog that cannot decode
  is a typed failure of the client's queries rather than an import-time throw.
- The catalog is still required on the client because `StartTrial` and `ScheduleTierChange` join
  the tier's terms in `BillingApiLayer` before sending the command. That is a property of the model
  (`decide` is pure), not of this API. The client-side catalog is now one field instead of a layer
  merge; the server's `CatalogGuard` is still the backstop against drift. The next slice is to move
  that join server-side so the browser needs no catalog at all; that is a model decision, not a
  config one, and is named in "What is not decided here".

### 4. Constructors encode the catalog's invariants in types

The runtime validator stays, because a catalog can arrive from JSON, a JS caller or an older build.
The constructors should make the same refusals a compile error for a TypeScript author, without
adding a required field or a second call.

**`feature()`** — a flag cannot carry a rate card, and a rate card must name `"default"`.

```ts
export type FeatureInput =
  | { readonly id: string; readonly name?: string; readonly kind?: "metered"; readonly creditRates?: CreditRates & { readonly default: number } }
  | { readonly id: string; readonly name?: string; readonly kind: "flag"; readonly creditRates?: never };
```

**`allowance()`** — a billed allowance is the only one that can state a cap, a unit price or a money
cap; an unlimited allowance can only allow; a carry needs a boundary.

```ts
type AllowanceBase = {
  readonly resets?: Resets;
  readonly carryOver?: boolean;
};

export type AllowanceInput =
  | (AllowanceBase & { readonly included: "unlimited"; readonly overage?: "allow"; readonly cap?: never; readonly unitPrice?: never; readonly moneyCap?: never })
  | (AllowanceBase & { readonly included: number; readonly overage?: "block" | "allow"; readonly cap?: never; readonly unitPrice?: never; readonly moneyCap?: never })
  | (AllowanceBase & { readonly included: number; readonly overage: "bill"; readonly cap?: number; readonly unitPrice?: UnitPrice; readonly moneyCap?: number });
```

`carryOver: true` with `resets: "never"` is still caught by the validator; expressing "a carry needs
a boundary" in the type would split every variant again for one field, and the validator's
`CatalogCarryOverNeverResets` already carries the evidence.

**`tier()`** — a subscription grants at least one allowance; a pack sells credits and a price, and
nothing else.

```ts
export type TierInput =
  | {
      readonly id: string;
      readonly name?: string;
      readonly kind?: "subscription";
      readonly price?: Price;
      readonly credits?: number;
      readonly creditsExpire?: CreditsExpire;
      readonly topUp?: number;
      readonly grants: readonly [Allowance, ...Allowance[]];
    }
  | {
      readonly id: string;
      readonly name?: string;
      readonly kind: "one_off";
      readonly price: Price;
      readonly credits: number;
      readonly creditsExpire?: "never";
      readonly topUp?: never;
      readonly grants?: readonly [];
    };
```

**`allowance()` / `grant()` know a literal feature's kind.** `feature()` returns
`Feature & { kind: K }` for a literal `K`, so a flag cannot be passed to `allowance()` and a metered
feature cannot be passed to `grant()`, while a value typed as the wide `Feature` still compiles and
is checked by the validator:

```ts
type Metered<F extends Feature> = "metered" extends F["kind"] ? F : F["kind"] extends "flag" ? never : F;
type Flag<F extends Feature> = "flag" extends F["kind"] ? F : F["kind"] extends "flag" ? F : never;

export const allowance = <F extends Feature>(feature: Metered<F>, input: AllowanceInput): Allowance => …
export const grant = <F extends Feature>(feature: Flag<F>): Allowance => …
```

The cost to a valid catalog is zero. The gain is that `CatalogFlagNotGranted`, `CatalogFlagOnMetered`,
`CatalogUnlimitedOverage`, `CatalogCapWithoutBilling`, `CatalogUnitPriceWithoutBilling`,
`CatalogMoneyCapWithoutUnitPrice`, `CatalogOneOffGrant`, `CatalogOneOffCredits`,
`CatalogOneOffWithoutPrice` and `CatalogTopUpOnPack` become editor errors in the common case, and
the validator remains the authority for the serialized path.

### 5. Vendor packages fuse provisioning and provider

`StripePrices` and `Stripe` are the right primitives, and the user currently writes both plus the
tier map twice:

```ts
const sold = yield* StripePrices("Prices", {
  tiers: { pro: { price: proPrice, usage: { messages: unitPrice } } },
});

const stripe = Stripe({
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      lookupKey: sold.prices.pro,
      usage: { messages: { unitPrice, lookupKey: sold.usage.pro.messages } },
    },
  },
  meters: sold.meters,
});

yield* Paykit.BillingStack("Billing", { catalog, providers: [stripe] });
```

`StripePrices` already holds everything `Stripe` needs: the catalog price per tier, the unit prices,
and the lookup keys it just created. A combined primitive should yield the resources and return the
provider, the way `StripePrices` already returns a plain value:

```ts
const stripe = yield* StripeBilling("Stripe", {
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, usage: { messages: unitPrice } } },
});

yield* Paykit.BillingStack("Billing", { catalog, providers: [stripe] });
```

`StripeBilling` is `StripePrices` + `Stripe` with the mapping derived once; it returns the
`MoneyProvider` and the `SoldPrices` (as `stripe.sold`) for a caller that wants the keys. The two
existing primitives stay: `StripePrices` for a deployment that manages the provider separately, and
`Stripe` for a lookup key written by hand. `PolarBilling` in `packages/paykit-polar` has the same
shape. Its product ids are `Output<string>`s because Polar mints them, so the provider keeps the
handle and resolves it at checkout or webhook time instead of forcing the declaration to wait for an
id that the deploy has not created yet.

This is the one place the design changes a vendor package rather than the core, and it follows the
Alchemy Stripe module's own split: `StripePrices` is the provisioning primitive, `Stripe(props)` is
the provider primitive, and a paykit deployment is the one caller that always needs both.

### 6. The HTTP edge owns the status map

Every example copies this:

```ts
const statusOf = (error: { readonly _tag?: string }): number => {
  switch (error._tag) {
    case "PlanNotInCatalog": return 400;
    case "Unauthenticated": return 401;
    case "Forbidden": return 403;
    case "PaymentDeclined": return 402;
    case "ProviderCapabilityMissing": return 501;
    default: return 500;
  }
};
```

Export one pure map for the package's refusals:

```ts
return HttpServerResponse.jsonUnsafe(
  { error: failure._tag },
  { status: Paykit.httpStatus(failure) },
);
```

`httpStatus` takes `{ readonly _tag: string }` and returns the default above; a deployment that
needs a different mapping writes its own switch, but the common one is not copied. The next step,
modeled on `Stripe.consumeEvents`, is `Paykit.handler({ account, admin? })` serving `/api`,
`/admin`, `/checkout` and `/webhooks` from one call, with the provider's decoder and the status map
already wired. That is a surface, not a config primitive, so it is a separate slice.

## Before and after

The TanStack example is the fullest, so it is the proof. `examples/billing`, `examples/auth` and
`examples/admin` collapse the same way.

### `src/billing.config.ts`

```ts
import { Paykit } from "@potion.run/paykit";

export const messages = Paykit.feature({ id: "messages", name: "Messages" });

export const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});

export const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});

export const billing = {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
} satisfies Paykit.BillingStackProps;
```

### `alchemy.run.ts`

```ts
const Example = Alchemy.Stack(
  "PaykitTanstackExample",
  { providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()), state: Alchemy.localState() },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing);
    const service = yield* BillingWorker;
    const site = yield* Cloudflare.Website.Vite("PaykitWebsite", { … });
    return { url: site.url.as<string>(), billing: service.url.as<string>(), tiers: recorded.tiers };
  }),
);
```

### `src/BillingWorker.ts`

```ts
const World = Paykit.world({
  ...billing,
  guards: InsecureDevGuards,
  platform: DomainCloudflare.layerDurableObjects(),
});

export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "PaykitBillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () { … }).pipe(Effect.provide(World), Effect.orDie),
) {}
```

### `src/billing.atoms.ts`

```ts
export const billing = PaykitAtom.make({
  url: "/api/billing",
  catalog: billing.catalog,
});
```

The `tierCommand`, `allowancesOfTier` and `Catalog = Effect.runSync(...)` helpers disappear. The
tests that need a model command can call `subscribeInputOf(billing.catalog, "free")` directly; the
binding tests use `yield* Paykit.Subscribe(account)` and `{ tier: "free" }`, which is the API the
docs already advertise.

## Migration

Each step leaves the gates green.

1. **Add `Paykit.BillingStack` and `Paykit.world` as the only names.** `Stack` and `paykitWorld`
   are removed. Rename the old `BillingStack` value type to `BillingDeployment` so
   the name `BillingStack` is the call, as `Stripe.Price` is both the call and the type. Add tests:
   one deploy-shaped test asserting the recorded attrs, one world test asserting `CatalogError` is
   in the layer's error channel, one test that `providerDescriptor` is not required by the new
   props.
2. **Add the `PaykitAtom.make({ url, catalog })` overload** and a test that the layer it builds
   serves an in-process client.
3. **Tighten the constructor types** (`FeatureInput`, `AllowanceInput`, `TierInput`, the
   `Metered`/`Flag` guards). Fix any internal call site the compiler finds; the runtime validator
   and its tests do not change.
4. **Add `StripeBilling`** in `packages/paykit-stripe` and the Polar equivalent, with one live-gated
   case each. Keep `StripePrices` and `Stripe` unchanged.
5. **Rewrite the four examples** to the config object, and delete the stale helpers. This is the
   proof the API is smaller, so the diff should delete more than it adds.
6. **Update `README.md`, `packages/paykit/README.md`, `packages/paykit/PLAN.md`, the website
   quickstart and `docs/NEXT.md`.** Add the ADR that accepts this brief.
7. **Gates:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`, `pnpm exports:check`, `pnpm validate:publish-packages`.

## What is not decided here

- **The client's catalog.** Moving `StartTrial` and `ScheduleTierChange`'s join server-side would
  remove the last catalog copy from the browser. That changes what the Api serves, so it is an ADR
  of its own.
- **A route primitive.** `Paykit.handler` is the natural next step after `httpStatus`; it needs a
  decision on how a deployment supplies its session (the `Session` service, or an `account` effect).
- **A `defineBilling()` object.** The plain config object above is enough for three surfaces. A
  method-bearing object would be a fourth concept, and ADR 0015 already rejected a second spelling
  of a binding; the same argument applies to configuration.
- **Typed tier ids at the binding boundary.** ADR 0015 explains why a tier is a `string` there: the
  binding validates it against the catalog, and a brand would buy nothing and cost every caller a
  cast. The type safety belongs in the constructors and in the deploy, where the catalog is present.

## Invariants this must not break

- **The catalog stays provider-free.** `BillingStackProps.providers` is runtime config; the recorded
  state is descriptors; no vendor id reaches `Feature`, `Tier` or `Allowance`.
- **One declaration of the stack.** `Paykit.BillingStack` is the only call that records
  `Paykit.BillingStack`; no example calls the resource directly.
- **`decide` stays pure.** No constructor type or config object moves a catalog read into `decide`.
- **The event log is the truth.** Nothing here changes what a command records, what a close bills,
  or what a destroy retains.
- **A missing guard is a type error, not a default.** `world` still has no development default for
  `guards`; omitting it leaves `Session | Admin` in the layer's requirements.
