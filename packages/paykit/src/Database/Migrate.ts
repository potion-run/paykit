import { Action, Stack, type Input } from "alchemy";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { migrationFingerprint, schemaFingerprint, sync } from "../Migrations/index.ts";
import { BILLING_TABLES, DEFAULT_SCHEMA } from "../Store/Tables.ts";
import { Database, type DatabaseService } from "./Database.ts";

/** The input one migration Action is keyed by. */
interface MigrateInput {
  /** Non-secret identity of the target database. */
  readonly identity: Input<Record<string, unknown>>;
  /** Fingerprint of the shipped DDL for this dialect. */
  readonly schema: string;
  /** Fingerprint of the shipped migration files. */
  readonly files: string;
  /** The target dialect; a dialect swap is a different schema. */
  readonly dialect: string;
}

/** What one deploy applied, created, converged and noticed. */
export interface MigrateOutput {
  readonly applied: ReadonlyArray<string>;
  readonly created: ReadonlyArray<string>;
  readonly columns: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<string>;
  readonly extra: ReadonlyArray<string>;
}

/** How a deployment wants its migrations handled. */
export interface RegisterMigrationsOptions {
  /**
   * `false` opts out — the deployment owns the schema, or another resource
   * already applies it (Cloudflare D1's `migrations` directory). `true` on a
   * target without migration support fails the deploy with a named error.
   * Default: run when the target supports it.
   */
  readonly migrate?: boolean;
  /** The Postgres schema. Defaults to the database layer's, then `billing`. */
  readonly schema?: string;
  /** The applied-migrations table. */
  readonly table?: string;
}

const migrationInput = (
  database: DatabaseService,
  schema: string | undefined,
  table: string,
): Effect.Effect<Omit<MigrateInput, "identity">> =>
  Effect.gen(function* () {
    const scope = { dialect: database.dialect, schema, table };

    return {
      dialect: database.dialect,
      schema: yield* schemaFingerprint(scope),
      files: yield* migrationFingerprint(scope),
    };
  });

/**
 * Register the deploy-time migration Action for a `Database`, mirroring
 * Alchemy's own `BetterAuth.Migrate`.
 *
 * The Action's input is the target's identity, the shipped DDL's fingerprint,
 * the shipped files' fingerprint and the dialect. Any of them changing re-runs
 * it on the next deploy; an unchanged deploy is a no-op. That is the difference
 * from a hand-written Action keyed by a directory path, which a new migration
 * file cannot change.
 *
 * It runs only during apply — never at plan, never inside the deployed runtime
 * — and its output is bound into the host environment, so a Worker depends on
 * the schema it needs. Call it from the stack, with the database layer
 * provided:
 *
 * ### Migrating on deploy
 * **Example:** One target, one action
 * ```ts
 * import { Postgres } from "@potion.run/paykit/Database/Postgres";
 *
 * Effect.gen(function* () {
 *   yield* Paykit.registerMigrations("Billing");
 *   const worker = yield* BillingWorker;
 *   return { url: worker.url };
 * }).pipe(Effect.provide(Postgres(Config.redacted("POSTGRES_URL"))));
 * ```
 *
 * @primitive
 */
const register = Effect.fn("Paykit.registerMigrations")(function* (
  database: DatabaseService,
  id: string,
  options: RegisterMigrationsOptions = {},
) {
  const support = database.migrate;

  if (support === undefined) {
    if (options.migrate === true) {
      return yield* Effect.die(
        new Error(
          `Paykit(${id}): \`migrate: true\` was requested, but the "${database.dialect}" ` +
            "database layer does not support automatic migrations. Drop `migrate: true` " +
            "(and apply the shipped files yourself) or provide a layer that migrates.",
        ),
      );
    }

    return;
  }

  if (options.migrate === false) return;

  // Outside a stack evaluation (a test driving the layer directly) there is no
  // Action to register on, so the call is a no-op.
  const stack = yield* Effect.serviceOption(Stack);

  if (Option.isNone(stack)) return;

  const schema =
    database.dialect === "mysql"
      ? undefined
      : (options.schema ?? database.schema ?? DEFAULT_SCHEMA);

  const table = options.table ?? BILLING_TABLES.schemaVersion;

  const Migrate = Action(
    "Paykit.Migrate",
    Effect.gen(function* () {
      // Init half: runs under the Action's capture context, so the Outer
      // connection's yielded Outputs are recorded as dependency captures.
      const acquire = yield* support.connect;

      return (_input: MigrateInput) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* acquire;
            const result = yield* sync(sql, { schema, table });

            return {
              applied: result.applied,
              created: result.created,
              columns: result.columns,
              indexes: result.indexes,
              extra: result.extra,
            } satisfies MigrateOutput;
          }),
        );
    }),
  );

  const result = yield* Migrate(`${id}Migrate`, {
    identity: support.identity,
    ...(yield* migrationInput(database, schema, table)),
  });

  // Bind the result into the host environment: the Worker's env then depends
  // on the migration's output, so first-deploy traffic cannot race the schema.
  const rc = yield* CurrentRuntimeContext;

  if (rc !== undefined) {
    // SAFETY: `set` records an Output for the host environment; `result` is the Action's Output of `MigrateOutput`.
    yield* rc.set(sanitizeKey(`${id}Migration`), result as never);
  }
});

/**
 * The public registration: the caller owns only `Database`. `Stack` and
 * `RuntimeContext` are the stack's own ambient services — present when a
 * deploy evaluates the stack, absent when a test or a Worker calls this, and
 * the body returns before touching either in that case.
 */
export const registerMigrations = (
  id: string,
  options: RegisterMigrationsOptions = {},
): Effect.Effect<void, never, Database> => {
  const effect: unknown = Effect.flatMap(Effect.service(Database), (database) =>
    register(database, id, options),
  );

  // SAFETY: the inner effect's only caller-owned requirement is `Database`; the ambient stack services are checked at runtime with `serviceOption`.
  return effect as Effect.Effect<void, never, Database>;
};

/**
 * Register a migration for a database value the caller already holds. This is
 * what `Paykit.BillingStack` calls when a `migrate` flag is declared, and it is
 * the same body `registerMigrations` runs after reading the service.
 *
 * A caller owns `RuntimeContext | Stack` here — they are ambient during stack
 * evaluation, and the body returns before touching either outside one.
 *
 * @internal
 */
export const registerDatabaseMigration = (
  database: DatabaseService,
  id: string,
  options: RegisterMigrationsOptions = {},
) => register(database, id, options);
