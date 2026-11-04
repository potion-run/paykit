import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Catalog } from "./Catalog.ts";

/** The catalog the runtime bindings read tiers from, provided beside the model. */
export class CatalogService extends Context.Service<CatalogService, Catalog>()("paykit/Catalog") {}

/** Provide one catalog to the bindings. */
export const catalogLayer = (catalog: Catalog): Layer.Layer<CatalogService> =>
  Layer.succeed(CatalogService, catalog);
