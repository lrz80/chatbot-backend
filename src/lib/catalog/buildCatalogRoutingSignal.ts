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
  | "catalog_compare"
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
    | "comparison"
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
  targetLevel:
    | "none"
    | "catalog"
    | "family"
    | "service"
    | "variant"
    | "multi_service"
    | "ambiguous_entity";

  disambiguationType:
    | "entity"
    | "family"
    | "variant"
    | "service_choice"
    | "none";

  candidateOptions?: Array<{
    serviceId: string;
    label: string;
  }>;
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

  expectingVariant?: boolean | null;
  pendingCatalogChoice?:
    | {
        kind?: "service_choice" | "variant_choice" | null;
        serviceId?: string | null;
        options?: Array<{
          serviceId?: string | null;
          variantId?: string | null;
          label?: string | null;
        }> | null;
      }
    | null;
};

type CatalogRoutingCandidateOption = {
  serviceId: string;
  label: string;
};

type BuildCatalogRoutingSignalArgs = {
  intentOut?: string | null;
  catalogReferenceClassification?: CatalogReferenceClassification | null;
  convoCtx?: CatalogRoutingConvoCtx | null;
  candidateOptionsFromTurn?: CatalogRoutingCandidateOption[] | null;
};

const CATALOG_INTENTS = new Set([
  "precio",
  "planes_precios",
  "info_servicio",
  "catalogo",
  "catalog",
  "horario",
  "horario_y_precios",
  "horarios_y_precios",
  "info_horarios_generales",
  "schedule",
  "schedule_and_price",
  "other_plans",
  "catalog_alternatives",
  "combination_and_price",
  "catalog_combination",
]);

function normalizeText(input?: string | null): string {
  return String(input || "").trim().toLowerCase();
}

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
  const intent = normalizeText(classification?.intent || "");
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
  if (kind === "comparison") return "catalog_compare";

  return "unknown";
}

function mapIntentOutToRouteIntent(intentOut?: string | null): CatalogRouteIntent {
  const intent = normalizeText(intentOut);

  if (intent === "other_plans" || intent === "catalog_alternatives") {
    return "catalog_alternatives";
  }

  if (intent === "combination_and_price" || intent === "catalog_combination") {
    return "catalog_combination";
  }

  if (
    intent === "info_horarios_generales" ||
    intent === "schedule" ||
    intent === "horario_y_precios" ||
    intent === "horario_y_precio" ||
    intent === "horarios_y_precio" ||
    intent === "horarios_y_precios" ||
    intent === "schedule_and_price"
  ) {
    return "catalog_schedule";
  }

  if (intent === "precio" || intent === "planes_precios") {
    return "catalog_price";
  }

  if (intent === "compare") {
    return "catalog_compare";
  }

  if (intent === "catalogo" || intent === "catalog") {
    return "catalog_overview";
  }

  return "unknown";
}

function hasExplicitTargetThisTurn(
  classification?: CatalogReferenceClassification | null
): boolean {
  return Boolean(
    String(classification?.targetServiceId || "").trim() ||
      String(classification?.targetVariantId || "").trim() ||
      String(classification?.targetFamilyKey || "").trim() ||
      classification?.kind === "entity_specific" ||
      classification?.kind === "variant_specific" ||
      classification?.kind === "catalog_family" ||
      classification?.kind === "referential_followup"
  );
}

function hasPendingCatalogChoice(
  convoCtx?: CatalogRoutingConvoCtx | null
): boolean {
  const pending = convoCtx?.pendingCatalogChoice;

  if (!pending) return false;

  return (
    pending.kind === "service_choice" ||
    pending.kind === "variant_choice"
  );
}

function hasReusableCatalogAnchor(
  convoCtx?: CatalogRoutingConvoCtx | null
): boolean {
  return Boolean(
    String(convoCtx?.last_service_id || "").trim() ||
      String(convoCtx?.selectedServiceId || "").trim() ||
      String(convoCtx?.last_variant_id || "").trim() ||
      String(convoCtx?.last_family_key || "").trim() ||
      convoCtx?.expectingVariant === true
  );
}

function canIntentLayerRouteCatalog(args: {
  intentOut: string;
  explicitTargetThisTurn: boolean;
  hasFreshCatalogContext: boolean;
  hasPendingChoice: boolean;
  hasReusableAnchor: boolean;
  hasAmbiguousEntityCandidates: boolean;
}): boolean {
  const intentOut = normalizeText(args.intentOut);

  if (!CATALOG_INTENTS.has(intentOut)) {
    return false;
  }

  if (intentOut !== "info_servicio") {
    return true;
  }

  return (
    args.explicitTargetThisTurn ||
    args.hasFreshCatalogContext ||
    args.hasPendingChoice ||
    args.hasReusableAnchor ||
    args.hasAmbiguousEntityCandidates
  );
}

function resolveRouteIntentFromSignals(args: {
  intentOut?: string | null;
  classification?: CatalogReferenceClassification | null;
  referenceKind:
    | "catalog_overview"
    | "catalog_family"
    | "entity_specific"
    | "variant_specific"
    | "referential_followup"
    | "comparison"
    | "none";
  targetServiceId: string | null;
  targetVariantId: string | null;
  targetFamilyKey: string | null;
  hasFreshCatalogContext: boolean;
}): CatalogRouteIntent {
  const {
    intentOut,
    classification,
    referenceKind,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  } = args;

  const classificationRouteIntent = mapClassificationToRouteIntent(classification);
  if (classificationRouteIntent !== "unknown") {
    return classificationRouteIntent;
  }

  if (targetVariantId) return "variant_detail";
  if (targetServiceId) return "entity_detail";
  if (targetFamilyKey) return "catalog_family";

  const intentRouteIntent = mapIntentOutToRouteIntent(intentOut);
  if (intentRouteIntent !== "unknown") {
    return intentRouteIntent;
  }

  if (referenceKind === "none") {
    return "catalog_overview";
  }

  return "unknown";
}

function classificationHasCandidates(
  classification?: CatalogReferenceClassification | null
): boolean {
  const candidateOptions = (classification as any)?.candidateOptions;
  const candidates = (classification as any)?.candidates;

  return (
    (Array.isArray(candidateOptions) && candidateOptions.length > 0) ||
    (Array.isArray(candidates) && candidates.length > 0)
  );
}

function normalizeCandidateOptions(input: {
  candidateOptionsFromTurn?: Array<{
    serviceId?: string;
    id?: string;
    label?: string;
    name?: string;
  }> | null;
  classification?: CatalogReferenceClassification | null;
}): Array<{ serviceId: string; label: string }> {
  const rawCandidates =
    (Array.isArray(input.candidateOptionsFromTurn) &&
    input.candidateOptionsFromTurn.length > 0
      ? input.candidateOptionsFromTurn
      : null) ||
    (classificationHasCandidates(input.classification)
      ? ((input.classification as any)?.candidateOptions ||
         (input.classification as any)?.candidates)
      : []) ||
    [];

  if (!Array.isArray(rawCandidates)) return [];

  const seen = new Set<string>();
  const result: Array<{ serviceId: string; label: string }> = [];

  for (const item of rawCandidates) {
    const serviceId = String(item?.serviceId || item?.id || "").trim();
    const label = String(item?.label || item?.name || "").trim();

    if (!serviceId || !label) continue;
    if (seen.has(serviceId)) continue;

    seen.add(serviceId);
    result.push({ serviceId, label });
  }

  return result;
}

export function buildCatalogRoutingSignal({
  intentOut,
  catalogReferenceClassification,
  convoCtx,
  candidateOptionsFromTurn,
}: BuildCatalogRoutingSignalArgs): CatalogRouteSignal {
  const referenceKind =
    catalogReferenceClassification?.kind === "catalog_overview" ||
    catalogReferenceClassification?.kind === "catalog_family" ||
    catalogReferenceClassification?.kind === "entity_specific" ||
    catalogReferenceClassification?.kind === "variant_specific" ||
    catalogReferenceClassification?.kind === "referential_followup" ||
    catalogReferenceClassification?.kind === "comparison"
      ? catalogReferenceClassification.kind
      : "none";

  const normalizedIntentOut = normalizeText(intentOut);
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

  const candidateOptions = normalizeCandidateOptions({
    candidateOptionsFromTurn,
    classification: catalogReferenceClassification,
  });

  const hasAmbiguousEntityCandidates =
    !String(catalogReferenceClassification?.targetServiceId || "").trim() &&
    !String(catalogReferenceClassification?.targetVariantId || "").trim() &&
    candidateOptions.length > 1;

  const effectiveTargetLevel =
    hasAmbiguousEntityCandidates
      ? "ambiguous_entity"
      : targetLevel;

  const effectiveDisambiguationType =
    hasAmbiguousEntityCandidates
      ? "service_choice"
      : disambiguationType;

  const explicitTargetThisTurn = hasExplicitTargetThisTurn(
    catalogReferenceClassification
  );

  const hasPendingChoice = hasPendingCatalogChoice(convoCtx);
  const hasReusableAnchor = hasReusableCatalogAnchor(convoCtx);

  const allowsDbCatalogPath = canIntentLayerRouteCatalog({
    intentOut: normalizedIntentOut,
    explicitTargetThisTurn,
    hasFreshCatalogContext,
    hasPendingChoice,
    hasReusableAnchor,
    hasAmbiguousEntityCandidates,
  });

  const shouldDropStaleTargets =
    !referenceKind || referenceKind === "none"
      ? (
          !allowsDbCatalogPath &&
          !explicitTargetThisTurn
        )
      : false;

  if (referenceKind !== "none") {
    const resolvedRouteIntent = resolveRouteIntentFromSignals({
      intentOut: normalizedIntentOut,
      classification: catalogReferenceClassification,
      referenceKind,
      targetServiceId,
      targetVariantId,
      targetFamilyKey,
      hasFreshCatalogContext,
    });

    return {
      shouldRouteCatalog: true,
      routeIntent: resolvedRouteIntent,
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
      targetLevel: effectiveTargetLevel,
      disambiguationType: effectiveDisambiguationType,
      anchorShift,
      candidateOptions,
    };
  }

  if (allowsDbCatalogPath) {
    const resolvedRouteIntent = resolveRouteIntentFromSignals({
      intentOut: normalizedIntentOut,
      classification: catalogReferenceClassification,
      referenceKind: "none",
      targetServiceId,
      targetVariantId,
      targetFamilyKey,
      hasFreshCatalogContext,
    });

    return {
      shouldRouteCatalog: true,
      routeIntent: resolvedRouteIntent,
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
      targetLevel: effectiveTargetLevel,
      disambiguationType: effectiveDisambiguationType,
      anchorShift,
      candidateOptions,
    };
  }

  if (hasFreshCatalogContext) {
    return {
      shouldRouteCatalog: false,
      routeIntent: "unknown",
      referenceKind: "none",
      source: "none",
      allowsDbCatalogPath,
      hasFreshCatalogContext,
      previousCatalogPlans,

      targetServiceId: null,
      targetServiceName: null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      targetLevel: "none",
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
    previousCatalogPlans: shouldDropStaleTargets ? [] : previousCatalogPlans,

    targetServiceId: shouldDropStaleTargets ? null : targetServiceId,
    targetServiceName: shouldDropStaleTargets ? null : targetServiceName,
    targetVariantId: shouldDropStaleTargets ? null : targetVariantId,
    targetVariantName: shouldDropStaleTargets ? null : targetVariantName,
    targetFamilyKey: shouldDropStaleTargets ? null : targetFamilyKey,
    targetFamilyName: shouldDropStaleTargets ? null : targetFamilyName,
    targetLevel: "none",
    disambiguationType: "none",
    anchorShift: "none",
  };
}