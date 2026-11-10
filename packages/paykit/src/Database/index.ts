// The billing database seam: a runtime service, a deploy migration service,
// and a layer per target. The layers that pull a driver live behind their own
// export condition (`./Database/Postgres`, `./Database/Sqlite`) so the root
// barrel never imports a Bun or pg module.

export { Database, type DatabaseService } from "./Database.ts";

export {
  DatabaseMigrate,
  registerMigrations,
  type DatabaseMigrateService,
  type MigrateOutput,
  type RegisterMigrationsOptions,
} from "./Migrate.ts";
