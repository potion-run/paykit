import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * A Postgres pool and the Drizzle instance over it.
 *
 * This is the whole point of the example: the application already has a
 * database, opened by its ORM. `Paykit.Database.Drizzle` unwraps the pool Drizzle
 * holds (`db.$client`), so paykit writes its own SQL through the same
 * connection — one pool, one transaction boundary, no second connection
 * string and no second migration owner.
 *
 * `max: 1` is the per-process shape this example wants; a host that serves
 * requests opens its own pool per execution (or goes through Hyperdrive).
 */
export interface DrizzleDatabase {
  readonly pool: Pool;
  readonly db: ReturnType<typeof drizzle>;
}

export const openDrizzle = (url: string): DrizzleDatabase => {
  const pool = new Pool({ connectionString: url, max: 1 });

  return { pool, db: drizzle({ client: pool }) };
};
