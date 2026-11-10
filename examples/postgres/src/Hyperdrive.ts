import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * The origin Hyperdrive pools connections to, parsed from the deployment's
 * `POSTGRES_URL`.
 *
 * It is an Effect, not a parsed value: Alchemy resolves it during deploy, so
 * the connection string is read from the stack's `ConfigProvider` and never
 * copied into state. At runtime the Worker only needs the binding, not the
 * origin, and `Connect` reads the binding by logical id.
 */
const origin = Effect.gen(function* () {
  const url = new URL(yield* Config.String("POSTGRES_URL"));
  const port = url.port === "" ? undefined : Number(url.port);

  return {
    scheme: "postgres" as const,
    host: url.hostname,
    ...(port === undefined ? {} : { port }),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
  };
});

/**
 * The one Hyperdrive configuration the Worker and the deploy share, written the
 * way Alchemy's own Hyperdrive examples declare it: a resource, a `dev` origin
 * for `alchemy dev`, and `Cloudflare.Hyperdrive.Connect` in the Worker.
 */
export const BillingHyperdrive = Cloudflare.Hyperdrive.Connection("BillingHyperdrive", {
  origin,
  dev: Effect.map(origin, (value) => ({ ...value, sslmode: "prefer" as const })),
});
