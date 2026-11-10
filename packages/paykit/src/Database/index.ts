// The billing database seam: one service, one deploy Action, and a layer per
// target. The layers that pull a driver live behind their own export
// condition (`./Database/Postgres`, `./Database/Sqlite`) so the root barrel
// never imports a Bun or pg module.

export { Database, type DatabaseMigrate, type DatabaseService } from "./Database.ts";

export {
  registerMigrations,
  type MigrateOutput,
  type RegisterMigrationsOptions,
} from "./Migrate.ts";
