import { defineConfig, type OxlintConfig } from "oxlint";

/**
 * The `effecttsgo/*` rules come from `@effect/tsgo`, which `pnpm prepare:patch`
 * installs into the local `oxlint` and `oxlint-tsgolint` binaries. They are
 * type-aware, so `options.typeAware` is what makes them run; `typeCheck` stays
 * off because `tsrs -b` already owns plain type errors and running both would
 * report every finding twice.
 *
 * A rule this tree satisfies is `error`, so the first violation fails the gate.
 * A rule with an outstanding finding is `warn`: it stays visible in every
 * `pnpm lint` run and is raised to `error` by fixing the finding, never by
 * adding a disable comment. A rule whose advice does not describe this repo is
 * `off` with the reason beside it.
 */
export default defineConfig({
  options: {
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: false,
  },
  plugins: ["import", "effecttsgo", "typescript", "node", "unicorn", "oxc"],
  ignorePatterns: [
    "**/lib/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/fixtures/**",
    "**/.agents/**",
    "**/.claude/**",
    "**/.codex/**",
    "**/.continue/**",
    "**/.cursor/**",
    "**/.gemini/**",
    "**/.opencode/**",
    "**/.pi/**",
    "**/.roo/**",
    "**/.windsurf/**",
    "**/.agent_sources/**",
    "**/.agent-sources/**",
    // Vendored anti-slop rules and their upstream tests; see
    // `tools/oxlint/anti-slop/UPSTREAM.md`.
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    "no-irregular-whitespace": "off",
    "no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    "no-useless-escape": "error",
    "require-yield": "off",

    "effecttsgo/abort-controller-in-effect": "error",
    "effecttsgo/acquire-release-disposable": "error",
    "effecttsgo/all-of-map-to-for-each": "error",
    "effecttsgo/any-unknown-in-error-context": "error",
    "effecttsgo/catch-all-tag-dispatch-to-catch-tag": "error",
    "effecttsgo/catch-all-to-map-error": "error",
    "effecttsgo/catch-chain-to-first-success-of": "error",
    "effecttsgo/catch-conditional-refail-to-catch-if": "error",
    "effecttsgo/catch-die-to-or-die": "error",
    "effecttsgo/catch-if-tag-to-catch-tag": "error",
    "effecttsgo/catch-refail-to-tap-error": "error",
    "effecttsgo/catch-tag-to-catch-reason": "error",
    "effecttsgo/catch-to-ignore": "error",
    "effecttsgo/catch-to-or-else-succeed": "error",
    "effecttsgo/catch-unfailable-effect": "error",
    "effecttsgo/class-self-mismatch": "error",
    "effecttsgo/duplicate-package": "error",
    "effecttsgo/effect-do-notation": "error",
    "effecttsgo/effect-fn-iife": "error",
    "effecttsgo/effect-fn-implicit-any": "error",
    "effecttsgo/effect-fn-opportunity": "error",
    "effecttsgo/effect-gen-uses-adapter": "error",
    "effecttsgo/effect-in-failure": "error",
    "effecttsgo/effect-in-void-success": "error",
    "effecttsgo/effect-map-flatten": "error",
    "effecttsgo/effect-map-void": "error",
    "effecttsgo/effect-sleep-zero-to-yield-now": "error",
    "effecttsgo/effect-succeed-with-void": "error",
    "effecttsgo/error-payload-shadows-name": "error",
    "effecttsgo/experimental-api-usage": "error",
    "effecttsgo/extends-native-error": "error",
    "effecttsgo/flat-map-conditional-to-filter-or-fail": "error",
    "effecttsgo/flat-map-ignored-param-to-and-then": "error",
    "effecttsgo/flat-map-to-map": "error",
    "effecttsgo/flat-map-to-tap": "error",
    "effecttsgo/floating-effect": "error",
    "effecttsgo/floating-effect-in-vitest": "error",
    "effecttsgo/generic-effect-services": "error",
    "effecttsgo/global-error-in-effect-catch": "error",
    "effecttsgo/global-error-in-effect-failure": "error",
    "effecttsgo/instance-of-schema": "error",
    "effecttsgo/layer-merge-all-with-dependencies": "error",
    // `BillingStackProvider()` and `providers()` stay functions: they are the
    // public Layer factories, they return a fresh Layer per call, and they keep
    // the build out of import time.
    "effecttsgo/lazy-effect": "off",
    "effecttsgo/lazy-promise-in-effect-sync": "error",
    "effecttsgo/leaking-requirements": "error",
    "effecttsgo/map-some-to-as-some": "error",
    "effecttsgo/match-effect-to-map-both": "error",
    "effecttsgo/match-effect-to-match": "error",
    "effecttsgo/missed-pipeable-opportunity": "off", // 29 sites, all style
    "effecttsgo/missing-effect-context": "error",
    "effecttsgo/missing-effect-error": "error",
    "effecttsgo/missing-effect-service-dependency": "error",
    "effecttsgo/missing-layer-context": "error",
    "effecttsgo/missing-return-yield-star": "error",
    "effecttsgo/missing-star-in-yield-effect-gen": "error",
    "effecttsgo/multiple-catch-tag": "error",
    // Its autofix collapses the chain into one `Layer.mergeAll`, which breaks
    // whenever a later `provide` is what satisfies an earlier one: the merged
    // form is what `layer-merge-all-with-dependencies` then reports. Read the
    // two layers and fix by hand.
    "effecttsgo/multiple-effect-provide": "error",
    "effecttsgo/nested-effect-gen-yield": "error",
    // Every refusal here is a `Schema.TaggedError` built with `new`, the
    // constructor Effect types: the payload is checked where the error is
    // declared, so `make` would validate what the compiler already proved.
    "effecttsgo/new-schema-class": "off", // 347, all this idiom
    "effecttsgo/non-object-effect-service-type": "error",
    "effecttsgo/obsolete-match-import": "error",
    "effecttsgo/obsolete-schema-import": "error",
    "effecttsgo/option-match-to-from-option": "error",
    "effecttsgo/outdated-api": "error",
    "effecttsgo/overridden-schema-constructor": "error",
    "effecttsgo/prefer-schema-type-property": "error",
    "effecttsgo/prefer-succeed-some-or-none": "error",
    "effecttsgo/prefer-typed-schema-decoder": "error",
    "effecttsgo/prefer-unsafe-constructor": "error",
    "effecttsgo/promise-in-effect-success": "error",
    "effecttsgo/provide-layer-succeed-to-provide-service": "error",
    "effecttsgo/race-first-with-sleep-to-timeout": "error",
    "effecttsgo/redundant-map-error": "error",
    "effecttsgo/redundant-or-die": "error",
    "effecttsgo/redundant-schema-tag-identifier": "error",
    "effecttsgo/return-effect-in-gen": "error",
    "effecttsgo/run-effect-inside-effect": "error",
    "effecttsgo/run-of-exit-to-run-exit": "error",
    // A tagged error carries `_tag` as a required unique literal, so two errors
    // with identical fields are not assignable to each other: `_tag` is the
    // brand the rule asks for.
    "effecttsgo/schema-class-missing-brand": "off", // 15
    "effecttsgo/schema-class-object-literal": "error",
    "effecttsgo/schema-literal-non-finite": "error",
    "effecttsgo/schema-number": "error",
    "effecttsgo/schema-opaque-instance-member": "error",
    "effecttsgo/schema-struct-with-tag": "error",
    // The two synchronous mappers (`SqlEventLog.rowToReadModel` and
    // `Doctor.decodeEvent`) are now the only schema runs outside an Effect, so
    // the rule is a gate rather than a reminder.
    "effecttsgo/schema-sync": "error",
    "effecttsgo/schema-sync-in-effect": "error",
    "effecttsgo/schema-union-of-literals": "error",
    "effecttsgo/scope-in-layer-effect": "error",
    "effecttsgo/service-not-as-class": "error",
    "effecttsgo/sync-to-succeed": "error",
    "effecttsgo/timeout-catch-tag-to-timeout-or-else": "error",
    "effecttsgo/try-catch-in-effect-gen": "error",
    "effecttsgo/unknown-in-effect-catch": "error",
    "effecttsgo/unnecessary-arrow-block": "error",
    "effecttsgo/unnecessary-effect-gen": "error",
    "effecttsgo/unnecessary-fail-yieldable-error": "error",
    "effecttsgo/unnecessary-pipe": "error",
    "effecttsgo/unnecessary-pipe-chain": "error",
    "effecttsgo/unnecessary-typeof-type": "error",
    "effecttsgo/unsafe-effect-type-assertion": "error",
    // Effect 4.0 moved `http`, `ai`, `sql` and `rpc` out of `effect/unstable/*`
    // while keeping them `@stability unstable`, so the rule fires on the imports
    // this package is built out of. There is no stable alternative to move to;
    // the catalog pin is what decides when they move.
    "effecttsgo/unstable-api-usage": "off", // 22

    "typescript/await-thenable": "error",
    "typescript/no-array-delete": "error",
    "typescript/no-base-to-string": "error",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/no-duplicate-type-constituents": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-for-in-array": "error",
    "typescript/no-implied-eval": "error",
    "typescript/no-meaningless-void-operator": "error",
    "typescript/no-misused-new": "off",
    "typescript/no-misused-spread": "error",
    "typescript/no-non-null-asserted-optional-chain": "off",
    "typescript/no-redundant-type-constituents": "error",
    "typescript/no-this-alias": "error",
    "typescript/no-unnecessary-parameter-property-assignment": "error",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-unsafe-unary-minus": "error",
    "typescript/no-useless-default-assignment": "off",
    "typescript/no-useless-empty-export": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/prefer-as-const": "error",
    "typescript/prefer-namespace-keyword": "error",
    "typescript/require-array-sort-compare": "error",
    "typescript/restrict-template-expressions": "error",
    "typescript/triple-slash-reference": "error",
    "typescript/unbound-method": "error",

    "unicorn/no-new-array": "error",
    "unicorn/no-useless-fallback-in-spread": "error",
    "unicorn/no-useless-length-check": "error",
    "unicorn/no-useless-spread": "error",
    "unicorn/prefer-string-starts-ends-with": "error",

    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    // The domain builds objects from `Schema.optionalKey` fields, where an
    // absent key and a `undefined` value are different encodings. The
    // conditional spread is how a projection keeps the absence explicit in one
    // expression; the rule's advice mutates a local instead, which is longer
    // and loses the purity of the mapper.
    "anti-slop/no-conditional-empty-object-spread": "off",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    // `Included = number | "unlimited"` and the other domain unions are
    // narrowed with `typeof`, which is the language's own discriminant check.
    // Parsing them again at every branch would add a schema run without adding
    // evidence; the schemas already own the I/O boundary.
    "anti-slop/no-runtime-typeof": "off",
    // "Shape" is Alchemy's term for a Resource's attributes
    // (`Resource<BillingStackShape>`), and the repo uses it for that meaning
    // everywhere, including in `AGENTS.md`.
    "anti-slop/no-shape-in-symbol-names": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unknown-type-aliases": "error",
    // The store, binding and JSON helpers take the type their boundary
    // actually hands them: a SQL row, a parsed body, a provider's metadata.
    // Each is decoded with the schema that owns it before it reaches a domain
    // type, and the generic defaults (`<A = Record<string, unknown>>`) mirror
    // the vendor APIs (`D1Like`, Alchemy's `SqlExecutor`) field for field.
    "anti-slop/no-unsafe-dictionary-type": "off",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    "anti-slop-effect/no-manual-effect-error-tag": "error",
    // The domain states its tagged unions as plain `_tag` objects (and, for
    // the Schema-backed ones, as a `Schema.Union` of `TaggedStruct`s with no
    // named variants). Branching on `_tag` and writing the literal is the
    // vocabulary the aggregates, views and tests share; a `Match` or a
    // constructor would not carry more evidence, and `Effect` matching is
    // already required where it applies (`effecttsgo/*` and
    // `prefer-effect-match`).
    "anti-slop-effect/no-manual-tag-comparison": "off",
    "anti-slop-effect/no-manual-tagged-construction": "off",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
  overrides: [
    {
      // Tests drive one Effect per case and assert on its `Exit`: composing a
      // fixture layer inline, narrowing a stubbed channel with a cast and
      // decoding a fixture synchronously are the test's own setup, not the
      // code under test. Every rule stays on outside `test/`, so the same shape
      // in a package's `src` still reports.
      //
      // The anti-slop rules follow the same line: a property test constructs
      // intentionally invalid states, asserts the exact tagged value it got
      // back and casts an arbitrary into the domain type it generated. Those
      // are fixture declarations, not production shapes.
      files: ["**/test/**"],
      rules: {
        "effecttsgo/any-unknown-in-error-context": "off",
        "effecttsgo/layer-merge-all-with-dependencies": "off",
        "effecttsgo/multiple-effect-provide": "off",
        "effecttsgo/schema-sync": "off",
        "effecttsgo/schema-sync-in-effect": "off",
        "effecttsgo/unnecessary-pipe-chain": "off",
        "effecttsgo/unsafe-effect-type-assertion": "off",
        "anti-slop/no-array-filter-map": "off",
        "anti-slop/no-chained-type-assertions": "off",
        "anti-slop/no-known-value-widening": "off",
        "anti-slop/no-object-parameters": "off",
        "anti-slop/require-safety-comment-for-type-assertion": "off",
        "anti-slop-effect/prefer-effect-match": "off",
      },
    },
  ],
} satisfies OxlintConfig);
