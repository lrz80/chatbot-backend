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
  targetVariantId: string | null;
  targetVariantName: string | null;
  targetFamilyKey: string | null;
  targetFamilyName: string | null;
  targetLevel: "catalog" | "family" | "service" | "variant" | "none";
  disambiguationType: "entity" | "family" | "variant" | "none";
  anchorShift:
    | "stay_on_anchor"
    | "switch_entity"
    | "switch_family"
    | "switch_variant"
    | "browse_catalog"
    | "none";
};

type CatalogRoutingConvoCtx = {
  last_catalog_plans?: string[] | null;
  last_catalog_at?: number | string | null;

  last_service_id?: string | null;
  last_service_name?: string | null;
  selectedServiceId?: string | null;

  last_variant_id?: string | null;
  last_variant_name?: string | null;

  last_family_key?: string | null;
  last_family_name?: string | null;
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
  "info_horarios_generales",
  "other_plans",
  "catalog_alternatives",
  "combination_and_price",
  "catalog_combination",
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

function mapClassificationToRouteIntent(
  classification?: CatalogReferenceClassification | null
): CatalogRouteIntent {
  const intent = String(classification?.intent || "").trim();
  const kind = classification?.kind || "none";

  if (intent === "other_plans") return "catalog_alternatives";
  if (intent === "combination_and_price") return "catalog_combination";
  if (intent === "schedule") return "catalog_schedule";
  if (intent === "includes") return "catalog_includes";
  if (intent === "price_or_plan") return "catalog_price";

  if (kind === "entity_specific") return "entity_detail";
  if (kind === "variant_specific") return "variant_detail";
  if (kind === "catalog_family") return "catalog_family";
  if (kind === "catalog_overview") return "catalog_overview";
  if (kind === "referential_followup") return "referential_followup";

  return "unknown";
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

  const normalizedIntentOut = String(intentOut || "").trim();
  const allowsDbCatalogPath = CATALOG_INTENTS.has(normalizedIntentOut);

  const hasFreshCatalogContext = isFreshCatalogContext(convoCtx);

  const previousCatalogPlans = Array.isArray(convoCtx?.last_catalog_plans)
    ? convoCtx!.last_catalog_plans
        .map((x: string) => String(x || "").trim())
        .filter(Boolean)
    : [];

  const targetServiceId =
    String(catalogReferenceClassification?.targetServiceId || "").trim() ||
    String(convoCtx?.last_service_id || "").trim() ||
    String(convoCtx?.selectedServiceId || "").trim() ||
    null;

  const targetServiceName =
    String(catalogReferenceClassification?.targetServiceName || "").trim() ||
    String(convoCtx?.last_service_name || "").trim() ||
    null;

  const targetVariantId =
    String(catalogReferenceClassification?.targetVariantId || "").trim() ||
    String(convoCtx?.last_variant_id || "").trim() ||
    null;

  const targetVariantName =
    String(catalogReferenceClassification?.targetVariantName || "").trim() ||
    String(convoCtx?.last_variant_name || "").trim() ||
    null;

  const targetFamilyKey =
    String(catalogReferenceClassification?.targetFamilyKey || "").trim() ||
    String(convoCtx?.last_family_key || "").trim() ||
    null;

  const targetFamilyName =
    String(catalogReferenceClassification?.targetFamilyName || "").trim() ||
    String(convoCtx?.last_family_name || "").trim() ||
    null;

  const targetLevel = catalogReferenceClassification?.targetLevel || "none";
  const disambiguationType = catalogReferenceClassification?.disambiguationType || "none";
  const anchorShift = catalogReferenceClassification?.anchorShift || "none";

  if (referenceKind !== "none") {
    return {
      shouldRouteCatalog: true,
      routeIntent: mapClassificationToRouteIntent(catalogReferenceClassification),
      referenceKind,
      source: "catalog_classifier",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,

      targetServiceId,
      targetServiceName,
      targetVariantId,
      targetVariantName,
      targetFamilyKey,
      targetFamilyName,
      targetLevel,
      disambiguationType,
      anchorShift,
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
      targetVariantId,
      targetVariantName,
      targetFamilyKey,
      targetFamilyName,
      targetLevel: "none",
      disambiguationType: "none",
      anchorShift: "none",
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
      targetVariantId,
      targetVariantName,
      targetFamilyKey,
      targetFamilyName,
      targetLevel: targetServiceId
        ? "service"
        : targetVariantId
        ? "variant"
        : targetFamilyKey
        ? "family"
        : "none",
      disambiguationType: "none",
      anchorShift: "none",
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
    targetVariantId,
    targetVariantName,
    targetFamilyKey,
    targetFamilyName,
    targetLevel: "none",
    disambiguationType: "none",
    anchorShift: "none",
  };
}