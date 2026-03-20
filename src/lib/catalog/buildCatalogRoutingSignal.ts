
import type { CatalogReferenceClassification } from "./types";

export type CatalogRouteIntent =
  | "catalog_overview"
  | "catalog_family"
  | "entity_detail"
  | "variant_detail"
  | "referential_followup"
  | "catalog_alternatives"
  | "catalog_combination"
  | "catalog_schedule"
  | "catalog_includes"
  | "catalog_price"
  | "unknown";

export type CatalogRouteSignal = {
  shouldRouteCatalog: boolean;
  routeIntent: CatalogRouteIntent;
  referenceKind:
    | "catalog_overview"
    | "catalog_family"
    | "entity_specific"
    | "variant_specific"
    | "referential_followup"
    | "none";
  source: "catalog_classifier" | "intent_layer" | "context" | "none";

  allowsDbCatalogPath: boolean;

  hasFreshCatalogContext: boolean;
  previousCatalogPlans: string[];

  targetServiceId: string | null;
  targetServiceName: string | null;
};

type CatalogRoutingConvoCtx = {
  last_catalog_plans?: string[] | null;
  last_catalog_at?: number | string | null;
  last_service_id?: string | null;
  last_service_name?: string | null;
  selectedServiceId?: string | null;
};

type BuildCatalogRoutingSignalArgs = {
  intentOut?: string | null;
  catalogReferenceClassification?: CatalogReferenceClassification | null;
  convoCtx?: CatalogRoutingConvoCtx | null;
};

const CATALOG_INTENTS = new Set([
  "precio",
  "planes_precios",
  "info_servicio",
  "catalogo",
  "catalog",
]);

function isFreshCatalogContext(convoCtx?: CatalogRoutingConvoCtx | null): boolean {
  const lastCatalogPlans = Array.isArray(convoCtx?.last_catalog_plans)
    ? convoCtx!.last_catalog_plans
    : [];

  const lastCatalogAt = Number(convoCtx?.last_catalog_at);

  return (
    lastCatalogPlans.length > 0 &&
    Number.isFinite(lastCatalogAt) &&
    lastCatalogAt > 0 &&
    Date.now() - lastCatalogAt <= 30 * 60 * 1000
  );
}

export function buildCatalogRoutingSignal({
  intentOut,
  catalogReferenceClassification,
  convoCtx,
}: BuildCatalogRoutingSignalArgs): CatalogRouteSignal {
  const referenceKind =
    catalogReferenceClassification?.kind === "catalog_overview" ||
    catalogReferenceClassification?.kind === "catalog_family" ||
    catalogReferenceClassification?.kind === "entity_specific" ||
    catalogReferenceClassification?.kind === "variant_specific" ||
    catalogReferenceClassification?.kind === "referential_followup"
      ? catalogReferenceClassification.kind
      : "none";

  const allowsDbCatalogPath = CATALOG_INTENTS.has(String(intentOut || "").trim());

  const hasFreshCatalogContext = isFreshCatalogContext(convoCtx);

  const previousCatalogPlans = Array.isArray(convoCtx?.last_catalog_plans)
    ? convoCtx!.last_catalog_plans
        .map((x: string) => String(x || "").trim())
        .filter(Boolean)
    : [];

  const targetServiceId =
    String(convoCtx?.last_service_id || "").trim() ||
    String(convoCtx?.selectedServiceId || "").trim() ||
    null;

  const targetServiceName =
    String(convoCtx?.last_service_name || "").trim() || null;

  if (referenceKind === "catalog_overview") {
    return {
      shouldRouteCatalog: true,
      routeIntent: "catalog_overview",
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (referenceKind === "catalog_family") {
    return {
      shouldRouteCatalog: true,
      routeIntent: "catalog_family",
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (referenceKind === "entity_specific") {
    return {
      shouldRouteCatalog: true,
      routeIntent: "entity_detail",
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (referenceKind === "variant_specific") {
    return {
      shouldRouteCatalog: true,
      routeIntent: "variant_detail",
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (referenceKind === "referential_followup") {
    return {
      shouldRouteCatalog: true,
      routeIntent: "referential_followup",
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (allowsDbCatalogPath) {
    return {
      shouldRouteCatalog: true,
      routeIntent: "catalog_price",
      referenceKind: "none",
      source: "intent_layer",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  if (hasFreshCatalogContext) {
    return {
      shouldRouteCatalog: true,
      routeIntent: "referential_followup",
      referenceKind: "none",
      source: "context",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,
      targetServiceId,
      targetServiceName,
    };
  }

  return {
    shouldRouteCatalog: false,
    routeIntent: "unknown",
    referenceKind: "none",
    source: "none",
    allowsDbCatalogPath,
    hasFreshCatalogContext,
    previousCatalogPlans,
    targetServiceId,
    targetServiceName,
  };
}