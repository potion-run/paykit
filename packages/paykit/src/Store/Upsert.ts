import type { SqlDialect } from "./Sql.ts";

const columns = (names: ReadonlyArray<string>): string => names.join(", ");
const placeholders = (names: ReadonlyArray<string>): string => names.map(() => "?").join(", ");

/**
 * `INSERT` a row, ignoring one that already exists.
 *
 * Each dialect spells it differently — SQLite `INSERT OR IGNORE`, Postgres
 * `ON CONFLICT DO NOTHING`, MySQL `INSERT IGNORE` — and the stores must not
 * each carry that branch.
 */
export const insertIgnoring = (
  dialect: SqlDialect,
  table: string,
  names: ReadonlyArray<string>,
): string => {
  const insert = `INSERT INTO ${table} (${columns(names)}) VALUES (${placeholders(names)})`;

  switch (dialect) {
    case "postgres":
      return `${insert} ON CONFLICT DO NOTHING`;
    case "mysql":
      return `INSERT IGNORE INTO ${table} (${columns(names)}) VALUES (${placeholders(names)})`;
    case "sqlite":
      return `INSERT OR IGNORE INTO ${table} (${columns(names)}) VALUES (${placeholders(names)})`;
  }
};

/** Columns an upsert also has to clear, ignoring the incoming row. */
export interface UpsertOptions {
  /** Columns set to `NULL` on a conflict, even though the insert does not name them. */
  readonly reset?: ReadonlyArray<string>;
}

/**
 * Insert one row, or update every non-key column of the row that conflicts on
 * `key`.
 *
 * SQLite and Postgres share `ON CONFLICT ... DO UPDATE SET col = excluded.col`;
 * MySQL spells the same thing `ON DUPLICATE KEY UPDATE col = VALUES(col)`, and
 * takes the conflict target implicitly from the unique key.
 */
export const upsertRow = (
  dialect: SqlDialect,
  table: string,
  names: ReadonlyArray<string>,
  key: ReadonlyArray<string>,
  options: UpsertOptions = {},
): string => {
  const updated = names.filter((name) => !key.includes(name));

  const assignments = updated.map((name) =>
    dialect === "mysql" ? `${name} = VALUES(${name})` : `${name} = excluded.${name}`,
  );

  for (const name of options.reset ?? []) assignments.push(`${name} = NULL`);

  const conflict =
    dialect === "mysql"
      ? `ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`
      : `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${assignments.join(", ")}`;

  return `INSERT INTO ${table} (${columns(names)}) VALUES (${placeholders(names)}) ${conflict}`;
};
