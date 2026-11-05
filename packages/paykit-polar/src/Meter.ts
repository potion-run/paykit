import * as Polar from "@distilled.cloud/polar";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * An identity part as a Polar name sees it: alphanumerics and dashes survive,
 * everything else (including `:` and `_`) becomes a `_<hex>_` escape, so two
 * parts can never forge the separator or each other.
 */
const encodePart = (value: string): string => {
  let encoded = "";
  for (const char of value) {
    encoded += /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`;
  }
  return encoded;
};

/** The stage-qualified meter name; with the feature in metadata, its identity. */
export const meterNameOf = (stage: string, feature: string): string =>
  `paykit:${encodePart(stage)}:meter:${encodePart(feature)}`;

/** The event name a feature's usage is ingested under. */
export const meterEventNameOf = (stage: string, feature: string): string =>
  `paykit_${encodePart(stage)}_${encodePart(feature)}`;

/** The metadata key that names the paykit feature; Polar has no lookup key. */
export const PAYKIT_FEATURE = "paykit_feature";

/** The meter's filter: events whose name is this feature's event name. */
export const meterFilterOf = (eventName: string): Polar.Filter => ({
  conjunction: "and",
  clauses: [{ property: "name", operator: "eq", value: eventName }],
});

/** How an ingested event's quantity becomes the meter's count. */
export const meterAggregationOf = (): Polar.PropertyAggregation => ({
  func: "sum",
  property: "metadata.units",
});

export interface MeterProps {
  /** The paykit feature the meter counts; with the stage, its identity. */
  readonly feature: string;
  /** The name usage events are ingested under. Defaults from stage and feature. */
  readonly eventName?: string;
  /** The name shown on invoices and usage. Defaults to the stage-qualified name. */
  readonly displayName?: string;
  /** Polar's unit label. `scalar` for a plain count. */
  readonly unit?: "scalar" | "token";
}

export type Meter = Resource<
  "Polar.Meter",
  MeterProps,
  {
    /** Polar meter id (`mtr_…`). */
    id: string;
    /** The stage-qualified name, `paykit:<encoded stage>:meter:<encoded feature>`. */
    name: string;
    /** The paykit feature the meter counts. */
    feature: string;
    /** The event name usage is ingested under. */
    eventName: string;
    /** The filter that selects this feature's events. */
    filter: Polar.Filter;
    /** The aggregation that turns events into units. */
    aggregation: Polar.MeterAggregation;
    /** Whether Polar has archived the meter. */
    archived: boolean;
    /** Polar's creation timestamp, used to pick the newest generation. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A Polar meter that sums one feature's billable units. Polar attaches a meter
 * to a metered price, so a postpaid feature needs one before `PolarPrices` can
 * create the price that charges it.
 *
 * The identity is `metadata.paykit_feature = "<feature>"` plus the
 * stage-qualified name, `paykit:<stage>:meter:<feature>`. A restored state
 * reconciles to the same meter instead of creating a second one, and a meter
 * with no ownership metadata is never adopted.
 *
 * ### Declaring a meter
 * **Example:** One meter per billable feature
 * ```typescript
 * const messages = yield* Meter("Meter_messages", { feature: "messages" });
 * // PolarPrices takes the meter id when it creates the metered price.
 * ```
 *
 * @resource
 * @product Meter
 */
export const Meter = Resource<Meter>("Polar.Meter");

const metadataOf = (meter: Polar.Meter): Record<string, string> =>
  Object.fromEntries(
    Object.entries(meter.metadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const featureOf = (meter: Polar.Meter): string => metadataOf(meter)[PAYKIT_FEATURE] ?? "";

const attrsOf = (meter: Polar.Meter): Meter["Attributes"] => {
  const clause = meter.filter.clauses[0];
  return {
    id: meter.id,
    name: meter.name,
    feature: featureOf(meter),
    eventName: clause !== undefined && "value" in clause ? String(clause.value) : "",
    filter: meter.filter,
    aggregation: meter.aggregation,
    archived: meter.archived_at != null,
    createdAt: meter.created_at,
  };
};

const sameFilter = (left: Polar.Filter, right: Polar.Filter): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const aggregationSignature = (aggregation: Polar.MeterAggregation): string =>
  "property" in aggregation
    ? `${aggregation.func ?? "count"}:${aggregation.property}`
    : (aggregation.func ?? "count");

const sameAggregation = (left: Polar.MeterAggregation, right: Polar.MeterAggregation): boolean =>
  aggregationSignature(left) === aggregationSignature(right);

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const listAll = Effect.fn(function* () {
  const meters: Polar.Meter[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const listed = yield* Polar.metersList({ limit: LIST_PAGE_SIZE, page });
    meters.push(...listed.items);
    if (page >= listed.pagination.max_page || listed.items.length === 0) break;
  }
  return meters;
});

/** Every generation of one feature's meter, newest first. */
const generationsOf = Effect.fn(function* (stage: string, feature: string) {
  const name = meterNameOf(stage, feature);
  const matches = (yield* listAll()).filter(
    (meter) => meter.name === name && featureOf(meter) === feature,
  );
  matches.sort((left, right) => right.created_at.localeCompare(left.created_at));
  return matches;
});

const findByFeature = Effect.fn(function* (stage: string, feature: string) {
  return (yield* generationsOf(stage, feature)).find((meter) => meter.archived_at == null);
});

const getById = (id: string) =>
  Polar.metersGet({ id }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (input: { id?: string; stage: string; feature: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByFeature(input.stage, input.feature);
});

const desiredMetadata = Effect.fn(function* (id: string, feature: string) {
  return {
    [PAYKIT_FEATURE]: feature,
    ...(yield* createInternalMetadata(id)),
  };
});

export const MeterProvider = () =>
  Provider.succeed(Meter, {
    stables: ["id", "eventName", "createdAt"],
    // A meter a metered price references is financial history, like the price
    // itself. `PolarPrices` declares it with `RemovalPolicy.retain`, and nuke
    // must not archive one out from under a retained product.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // Polar cannot rename a meter's event, so an explicit change is a
      // replacement. An omitted eventName keeps the stage-derived one.
      if (
        news.eventName !== undefined &&
        output !== undefined &&
        output.eventName !== news.eventName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const stage = yield* Stage;
      const existing = yield* observe({
        id: output?.id,
        stage,
        feature: output?.feature ?? olds.feature,
      });
      if (existing === undefined) return undefined;
      const attrs = attrsOf(existing);
      return (yield* hasAlchemyMetadata(id, metadataOf(existing))) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const meters = (yield* listAll()).filter((meter) => meter.archived_at == null);
      return meters
        .filter((meter) => metadataOf(meter)[alchemyMetadataKeys.stack] !== undefined)
        .map(attrsOf);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const stage = yield* Stage;
      const feature = news.feature;
      const name = meterNameOf(stage, feature);
      const eventName = news.eventName ?? meterEventNameOf(stage, feature);
      const displayName = news.displayName ?? name;
      const filter = meterFilterOf(eventName);
      const aggregation = meterAggregationOf();
      const metadata = yield* desiredMetadata(id, feature);

      let current = yield* observe({ id: output?.id, stage, feature });

      if (current === undefined) {
        current = yield* Polar.metersCreate({
          name: displayName,
          unit: news.unit ?? "scalar",
          filter,
          aggregation,
          metadata,
        });
      }

      const observed = metadataOf(current);
      const metadataDiff = diffMetadata(observed, metadata);
      const metadataChanged = metadataDiff.upsert.length > 0 || metadataDiff.removed.length > 0;
      const nameChanged = current.name !== displayName;
      const filterChanged = !sameFilter(current.filter, filter);
      const aggregationChanged = !sameAggregation(current.aggregation, aggregation);

      if (!nameChanged && !filterChanged && !aggregationChanged && !metadataChanged) {
        return attrsOf(current);
      }

      const updated = yield* Polar.metersUpdate({
        id: current.id,
        name: displayName,
        ...(filterChanged ? { filter } : {}),
        ...(aggregationChanged ? { aggregation } : {}),
        ...(metadataChanged ? { metadata } : {}),
      });
      return attrsOf(updated);
    }),

    // Retention, not deletion. Archiving a meter a retained price references is
    // its own decision; `PolarPrices` retains the meter like the product.
    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || existing.archived_at != null) return;
      yield* Polar.metersUpdate({ id: existing.id, is_archived: true });
    }),
  });
