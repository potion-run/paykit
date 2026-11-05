import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * Better Auth owns its own tables. This database is only for sign-up, sign-in
 * and sessions; paykit's model in this example runs on `MemoryStore`.
 *
 * A real deployment that wants durable billing swaps the store in
 * `src/Billing.ts` — the auth database stays where it is.
 */
export const AuthDatabase = Cloudflare.D1.Database("AuthDatabase");
