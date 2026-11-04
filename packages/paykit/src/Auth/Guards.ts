import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { Actor } from "./Actor.ts";
import { Forbidden } from "./Forbidden.rejection.ts";
import { Unauthenticated } from "./Unauthenticated.rejection.ts";

/**
 * The tenant guard: every command and read a signed-in account may reach
 * declares it. It resolves the caller from the request and provides it as
 * `Actor`; an `account` actor may only target itself, while an `admin` or the
 * `system` may target any account.
 *
 * Provide a Layer in production that reads your own session (a cookie, a
 * bearer token, a signed header). `SessionFromHeaders` is the development
 * implementation.
 *
 * ### Guarding a command
 * **Example:** A command a signed-in account may send
 * ```typescript
 * export class TrackUsage extends Domain.Command("TrackUsage", {
 *   target: AccountId,
 *   input: { feature: Schema.String, amount: Schema.Int },
 *   events: [UsageRecorded],
 *   rejects: [AllowanceExceeded, StandingBlocksUsage],
 *   middleware: [Session],
 * }) {}
 * ```
 *
 * @primitive
 */
export class Session extends RpcMiddleware.Service<Session, { provides: Actor }>()(
  "paykit/Session",
  {
    error: Schema.Union([Unauthenticated, Forbidden]),
  },
) {}

/**
 * The operator guard: commands with a blast radius wider than one account —
 * granting credit, expiring a standing, replaying a charge — declare it. It
 * requires an actor whose kind is `admin`; a tenant session cannot reach one.
 *
 * @primitive
 */
export class Admin extends RpcMiddleware.Service<Admin, { provides: Actor }>()("paykit/Admin", {
  error: Schema.Union([Unauthenticated, Forbidden]),
}) {}
