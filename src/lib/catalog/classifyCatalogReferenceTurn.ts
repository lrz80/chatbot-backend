//src/lib/catalog/classifyCatalogReferenceTurn.ts
import type {
  CatalogAnchorShift,
  CatalogDisambiguationType,
  CatalogReferenceClassification,
  CatalogReferenceClassificationInput,
  CatalogReferenceContext,
  CatalogReferenceIntent,
  CatalogReferenceSignals,
} from "./types";

import { isExplicitCatalogBrowseIntent } from "./isExplicitCatalogBrowseIntent";

function normalizeUserText(input: string): string {
  return String(input || "").trim();
}

function normalizeForMatching(input: string): string {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeContext(
  context?: Partial<CatalogReferenceContext> | null
): CatalogReferenceContext {
  return {
    lastEntityId: context?.lastEntityId ?? null,
    lastEntityName: context?.lastEntityName ?? null,

    lastFamilyKey: context?.lastFamilyKey ?? null,
    lastFamilyName: context?.lastFamilyName ?? null,

    lastPresentedEntityIds: Array.isArray(context?.lastPresentedEntityIds)
      ? context.lastPresentedEntityIds.filter((v): v is string => Boolean(v))
      : [],

    lastPresentedFamilyKeys: Array.isArray(context?.lastPresentedFamilyKeys)
      ? context.lastPresentedFamilyKeys.filter((v): v is string => Boolean(v))
      : [],

    expectingVariantForEntityId: context?.expectingVariantForEntityId ?? null,

    lastResolvedIntent: context?.lastResolvedIntent ?? null,
    expectedVariantIntent: context?.expectedVariantIntent ?? null,

    presentedVariantOptions: Array.isArray(context?.presentedVariantOptions)
      ? context.presentedVariantOptions.map((opt: any) => ({
          index: Number(opt?.index || 0),
          variantId: String(opt?.variantId || ""),
          label: String(opt?.label || ""),
          aliases: Array.isArray(opt?.aliases)
            ? opt.aliases.filter((v: any): v is string => Boolean(v))
            : [],
        }))
      : [],
  };
}

function tokenizeUserText(input: string): string[] {
  return normalizeForMatching(input)
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function mapDetectedIntentToCatalogIntent(
  detectedIntent: string | null,
  fallback: CatalogReferenceIntent = "unknown"
): CatalogReferenceIntent {
  const value = String(detectedIntent || "").trim().toLowerCase();

  switch (value) {
    case "precio":
    case "planes_precios":
    case "catalogo":
    case "catalog":
      return "price_or_plan";

    case "info_servicio":
      return "includes";

    case "horario":
    case "info_horarios_generales":
      return "schedule";

    case "other_plans":
    case "catalog_alternatives":
      return "other_plans";

    case "combination_and_price":
    case "catalog_combination":
      return "combination_and_price";

    case "compare":
    case "comparison":
    case "comparacion":
    case "catalog_compare":
      return "compare";

    default:
      return fallback;
  }
}

function isExplicitCompareIntent(
  detectedIntent: string | null | undefined
): boolean {
  const value = String(detectedIntent || "").trim().toLowerCase();

  return (
    value === "compare" ||
    value === "comparison" ||
    value === "comparacion" ||
    value === "catalog_compare"
  );
}

function isSafeContextIntent(
  value: string | null | undefined
): value is CatalogReferenceIntent {
  if (!value) return false;

  return (
    value === "price_or_plan" ||
    value === "includes" ||
    value === "schedule" ||
    value === "other_plans" ||
    value === "combination_and_price" ||
    value === "compare" ||
    value === "unknown"
  );
}

function inferIntentFromContext(params: {
  detectedIntent: string | null;
  context: CatalogReferenceContext;
}): CatalogReferenceIntent {
  const mapped = mapDetectedIntentToCatalogIntent(
    params.detectedIntent,
    "unknown"
  );
  if (mapped !== "unknown") return mapped;

  const { context } = params;

  if (isSafeContextIntent(context.expectedVariantIntent)) {
    return context.expectedVariantIntent;
  }

  if (isSafeContextIntent(context.lastResolvedIntent)) {
    return context.lastResolvedIntent;
  }

  return "unknown";
}

function buildSignals(params: {
  userText: string;
  context: CatalogReferenceContext;
  explicitEntityCandidate: CatalogReferenceClassificationInput["explicitEntityCandidate"];
  explicitFamilyCandidate: CatalogReferenceClassificationInput["explicitFamilyCandidate"];
  explicitVariantCandidate: CatalogReferenceClassificationInput["explicitVariantCandidate"];
}): CatalogReferenceSignals {
  const {
    userText,
    context,
    explicitEntityCandidate,
    explicitFamilyCandidate,
    explicitVariantCandidate,
  } = params;

  const tokens = tokenizeUserText(userText);

  const hasLastEntity = Boolean(context.lastEntityId);
  const hasLastFamily = Boolean(context.lastFamilyKey);
  const hasPresentedEntities = context.lastPresentedEntityIds.length > 0;
  const hasPresentedFamilies = context.lastPresentedFamilyKeys.length > 0;
  const hasExpectedVariant = Boolean(context.expectingVariantForEntityId);

  const hasConversationDependency =
    hasLastEntity ||
    hasLastFamily ||
    hasPresentedEntities ||
    hasPresentedFamilies ||
    hasExpectedVariant;

  const hasReferentialDependency =
    hasExpectedVariant ||
    ((hasLastEntity ||
      hasPresentedEntities ||
      hasLastFamily ||
      hasPresentedFamilies) &&
      tokens.length > 0 &&
      tokens.length <= 6);

  const hasSpecificEntityCandidate = Boolean(explicitEntityCandidate?.id);
  const hasVariantCandidate = Boolean(explicitVariantCandidate?.variantId);
  const hasFamilyCandidate = Boolean(explicitFamilyCandidate?.familyKey);

  const hasCatalogScope =
    !hasReferentialDependency &&
    !hasConversationDependency &&
    (hasSpecificEntityCandidate ||
      hasVariantCandidate ||
      hasFamilyCandidate);

  const hasDisambiguationRisk =
    context.lastPresentedEntityIds.length > 1 ||
    context.lastPresentedFamilyKeys.length > 1 ||
    (Array.isArray(context.presentedVariantOptions) &&
      context.presentedVariantOptions.length > 1);

  const hasAnchorShift =
    (hasSpecificEntityCandidate &&
      hasLastEntity &&
      String(explicitEntityCandidate?.id || "").trim() !==
        String(context.lastEntityId || "").trim()) ||
    (hasFamilyCandidate &&
      hasLastFamily &&
      String(explicitFamilyCandidate?.familyKey || "").trim() !==
        String(context.lastFamilyKey || "").trim()) ||
    (hasVariantCandidate &&
      hasExpectedVariant &&
      Boolean(
        Array.isArray(context.presentedVariantOptions) &&
          context.presentedVariantOptions.some(
            (v) =>
              String(v.variantId || "").trim() !==
              String(explicitVariantCandidate?.variantId || "").trim()
          )
      ));

  return {
    hasCatalogScope,
    hasSpecificEntityCandidate,
    hasVariantCandidate,
    hasFamilyCandidate,
    hasReferentialDependency,
    hasConversationDependency,
    hasDisambiguationRisk,
    hasAnchorShift,
  };
}

function buildBaseClassification(
  signals: CatalogReferenceSignals
): CatalogReferenceClassification {
  return {
    kind: "none",
    intent: "unknown",
    confidence: 0,

    signals,

    shouldUseContextFirst: false,
    shouldResolvePluralCatalog: false,
    shouldResolveFamily: false,
    shouldResolveEntity: false,
    shouldResolveVariant: false,
    shouldAskDisambiguation: false,

    targetLevel: "none",

    targetServiceId: null,
    targetServiceName: null,

    targetVariantId: null,
    targetVariantName: null,

    targetFamilyKey: null,
    targetFamilyName: null,

    disambiguationType: "none",
    anchorShift: "none",

    debug: {
      source: "catalog_reference_classifier",
      notes: [],
    },
  };
}

function inferDisambiguationType(
  context: CatalogReferenceContext
): CatalogDisambiguationType {
  const variantCount = Array.isArray(context.presentedVariantOptions)
    ? context.presentedVariantOptions.length
    : 0;

  if (variantCount > 1) return "variant";
  if (context.lastPresentedEntityIds.length > 1) return "entity";
  if (context.lastPresentedFamilyKeys.length > 1) return "family";
  return "none";
}

function inferAnchorShift(params: {
  context: CatalogReferenceContext;
  explicitEntityCandidate: CatalogReferenceClassificationInput["explicitEntityCandidate"];
  explicitFamilyCandidate: CatalogReferenceClassificationInput["explicitFamilyCandidate"];
  explicitVariantCandidate: CatalogReferenceClassificationInput["explicitVariantCandidate"];
  signals: CatalogReferenceSignals;
}): CatalogAnchorShift {
  const {
    context,
    explicitEntityCandidate,
    explicitFamilyCandidate,
    explicitVariantCandidate,
    signals,
  } = params;

  if (explicitVariantCandidate?.variantId) {
    return context.expectingVariantForEntityId
      ? "switch_variant"
      : "stay_on_anchor";
  }

  if (explicitEntityCandidate?.id) {
    if (
      context.lastEntityId &&
      String(explicitEntityCandidate.id || "").trim() !==
        String(context.lastEntityId || "").trim()
    ) {
      return "switch_entity";
    }
    return "stay_on_anchor";
  }

  if (explicitFamilyCandidate?.familyKey) {
    if (
      context.lastFamilyKey &&
      String(explicitFamilyCandidate.familyKey || "").trim() !==
        String(context.lastFamilyKey || "").trim()
    ) {
      return "switch_family";
    }
    return "stay_on_anchor";
  }

  if (signals.hasCatalogScope) return "browse_catalog";

  return "none";
}

function isCatalogFollowupIntent(
  detectedIntent: string | null | undefined
): boolean {
  const mapped = mapDetectedIntentToCatalogIntent(
    String(detectedIntent || "").trim() || null,
    "unknown"
  );

  return (
    mapped === "price_or_plan" ||
    mapped === "includes" ||
    mapped === "schedule" ||
    mapped === "other_plans" ||
    mapped === "combination_and_price" ||
    mapped === "compare"
  );
}

function canUseEntityContextAsClearFollowup(params: {
  detectedIntent: string | null;
  tokenCount: number;
  hasExpectedVariant: boolean;
  hasLastEntity: boolean;
  hasPresentedEntities: boolean;
  hasLastFamily: boolean;
  hasPresentedFamilies: boolean;
  signals: CatalogReferenceSignals;
}): boolean {
  const {
    detectedIntent,
    tokenCount,
    hasExpectedVariant,
    hasLastEntity,
    hasPresentedEntities,
    hasLastFamily,
    hasPresentedFamilies,
    signals,
  } = params;

  if (hasExpectedVariant) {
    return tokenCount > 0 && tokenCount <= 6;
  }

  const hasEntityContext = hasLastEntity || hasPresentedEntities;
  const hasFamilyContext = hasLastFamily || hasPresentedFamilies;

  if (!hasEntityContext && !hasFamilyContext) {
    return false;
  }

  if (!isCatalogFollowupIntent(detectedIntent)) {
    return false;
  }

  return (
    signals.hasReferentialDependency ||
    signals.hasSpecificEntityCandidate ||
    signals.hasVariantCandidate ||
    signals.hasFamilyCandidate
  );
}

function hasAnyToken(tokens: string[], allowed: Set<string>): boolean {
  return tokens.some((token) => allowed.has(token));
}

function isGenericCatalogOverviewSignal(params: {
  userText: string;
  detectedIntent: string | null;
  tokens: string[];
  hasAnyContext: boolean;
  hasStructuralCatalogEvidence: boolean;
}): boolean {
  const {
    detectedIntent,
    tokens,
    hasAnyContext,
    hasStructuralCatalogEvidence,
  } = params;

  if (hasAnyContext || hasStructuralCatalogEvidence) {
    return false;
  }

  if (isExplicitCatalogBrowseIntent(detectedIntent)) {
    return true;
  }

  const mappedIntent = mapDetectedIntentToCatalogIntent(
    detectedIntent,
    "unknown"
  );

  const catalogOverviewNouns = new Set<string>([
    "plan",
    "planes",
    "paquete",
    "paquetes",
    "package",
    "packages",
    "membership",
    "memberships",
    "membresia",
    "membresias",
  ]);

  const browseCues = new Set<string>([
    "tienes",
    "tienen",
    "hay",
    "ofreces",
    "ofrecen",
    "muestrame",
    "muestra",
    "mostrar",
    "ensename",
    "lista",
    "available",
    "show",
    "list",
    "offer",
    "offers",
    "have",
  ]);

  const hasCatalogNoun = hasAnyToken(tokens, catalogOverviewNouns);
  if (!hasCatalogNoun) return false;

  const hasBrowseCue = hasAnyToken(tokens, browseCues);
  const isShortTurn = tokens.length > 0 && tokens.length <= 8;

  if (mappedIntent === "price_or_plan" || mappedIntent === "other_plans") {
    return true;
  }

  if (detectedIntent === "info_general" && isShortTurn) {
    return true;
  }

  if (hasBrowseCue && isShortTurn) {
    return true;
  }

  if (tokens.length === 1) {
    return true;
  }

  return false;
}

export function classifyCatalogReferenceTurn(
  input: CatalogReferenceClassificationInput
): CatalogReferenceClassification {
  
  const userText = normalizeUserText(input?.userText || "");
  const context = sanitizeContext(input?.context);

  const explicitEntityCandidate = input?.explicitEntityCandidate ?? null;
  const explicitFamilyCandidate = input?.explicitFamilyCandidate ?? null;
  const explicitVariantCandidate = input?.explicitVariantCandidate ?? null;

  const detectedIntent = String(input?.detectedIntent || "").trim() || null;
  const tokens = tokenizeUserText(userText);

  const signals = buildSignals({
    userText,
    context,
    explicitEntityCandidate,
    explicitFamilyCandidate,
    explicitVariantCandidate,
  });

  const result = buildBaseClassification(signals);
  const notes: string[] = [];

  if (!userText) {
    notes.push("empty_user_text");
    result.debug.notes = notes;
    return result;
  }

  const tokenCount = tokens.length;
  const hasLastEntity = Boolean(context.lastEntityId);
  const hasLastFamily = Boolean(context.lastFamilyKey);
  const hasPresentedEntities = context.lastPresentedEntityIds.length > 0;
  const hasPresentedFamilies = context.lastPresentedFamilyKeys.length > 0;
  const hasExpectedVariant = Boolean(context.expectingVariantForEntityId);

  const hasAnyContext =
    hasLastEntity ||
    hasLastFamily ||
    hasPresentedEntities ||
    hasPresentedFamilies ||
    hasExpectedVariant;

  notes.push(`token_count:${tokenCount}`);

  const catalogCapableIntents = new Set([
    "precio",
    "planes_precios",
    "info_servicio",
    "catalogo",
    "catalog",
    "horario",
    "horarios_y_precios",
    "info_horarios_generales",
    "other_plans",
    "catalog_alternatives",
    "combination_and_price",
    "catalog_combination",
    "info_general",
  ]);

  const hasStructuredComparisonEvidence =
    Boolean(input.structuredComparison?.hasComparison) &&
    isExplicitCompareIntent(detectedIntent);

  const hasStructuralCatalogEvidence =
    Boolean(explicitEntityCandidate?.id) ||
    Boolean(explicitVariantCandidate?.variantId) ||
    Boolean(explicitFamilyCandidate?.familyKey) ||
    hasStructuredComparisonEvidence ||
    Boolean(context.expectingVariantForEntityId) ||
    signals.hasReferentialDependency ||
    signals.hasConversationDependency;

  const hasGenericCatalogOverviewSignal = isGenericCatalogOverviewSignal({
    userText,
    detectedIntent,
    tokens,
    hasAnyContext,
    hasStructuralCatalogEvidence,
  });

  if (
    detectedIntent &&
    !catalogCapableIntents.has(detectedIntent) &&
    !hasStructuralCatalogEvidence &&
    !hasGenericCatalogOverviewSignal
  ) {
    notes.push(`non_catalog_intent:${detectedIntent}`);
    result.debug.notes = notes;
    return result;
  }

  result.intent = inferIntentFromContext({
    detectedIntent,
    context,
  });

  result.disambiguationType = inferDisambiguationType(context);
  result.anchorShift = inferAnchorShift({
    context,
    explicitEntityCandidate,
    explicitFamilyCandidate,
    explicitVariantCandidate,
    signals,
  });

  // =========================================================
  // 0) EXPLICIT VARIANT CANDIDATE
  // =========================================================
  if (explicitVariantCandidate?.variantId) {
    notes.push("explicit_variant_candidate");
    notes.push(
      `explicit_variant_score:${Number(explicitVariantCandidate.score || 0)}`
    );

    result.kind = "variant_specific";
    result.confidence = Math.max(
      0.82,
      Math.min(0.97, Number(explicitVariantCandidate.score || 0))
    );

    result.signals.hasCatalogScope = true;
    result.signals.hasSpecificEntityCandidate = false;
    result.signals.hasVariantCandidate = true;
    result.signals.hasFamilyCandidate = false;

    result.shouldUseContextFirst = false;
    result.shouldResolveVariant = true;

    result.targetLevel = "variant";

    result.targetVariantId =
      String(explicitVariantCandidate.variantId || "").trim() || null;
    result.targetVariantName =
      String(explicitVariantCandidate.label || "").trim() || null;

    result.targetServiceId =
      String(explicitVariantCandidate.serviceId || "").trim() || null;
    result.targetServiceName =
      String(explicitVariantCandidate.serviceName || "").trim() || null;

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 1) STRUCTURED COMPARISON
  // =========================================================
  if (
    input.structuredComparison?.hasComparison &&
    Array.isArray(input.structuredComparison.serviceIds) &&
    input.structuredComparison.serviceIds.length >= 2
  ) {
    notes.push("structured_comparison_detected");

    result.kind = "comparison";
    result.intent = "compare";
    result.confidence = 0.9;

    result.signals.hasCatalogScope = true;
    result.signals.hasSpecificEntityCandidate = true;
    result.signals.hasVariantCandidate = false;
    result.signals.hasFamilyCandidate = false;
    result.signals.hasReferentialDependency = false;
    result.signals.hasConversationDependency = false;
    result.signals.hasDisambiguationRisk = false;
    result.signals.hasAnchorShift = false;

    result.shouldUseContextFirst = false;
    result.shouldResolvePluralCatalog = false;
    result.shouldResolveFamily = false;
    result.shouldResolveEntity = false;
    result.shouldResolveVariant = false;
    result.shouldAskDisambiguation = false;

    result.targetLevel = "multi_service";
    result.targetServiceId = null;
    result.targetServiceName = null;
    result.targetVariantId = null;
    result.targetVariantName = null;
    result.targetFamilyKey = null;
    result.targetFamilyName = null;

    result.targetServiceIds = input.structuredComparison.serviceIds;
    result.targetServiceNames = input.structuredComparison.serviceNames;

    result.disambiguationType = "none";
    result.anchorShift = "none";

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 2) EXPLICIT ENTITY CANDIDATE
  // FUENTE DE VERDAD ESTRUCTURADA: si llega aquí, se respeta.
  // =========================================================
  if (explicitEntityCandidate?.id) {
    notes.push("explicit_entity_candidate_from_catalog_matcher");
    notes.push(
      `explicit_entity_score:${Number(explicitEntityCandidate.score || 0)}`
    );
    notes.push("explicit_entity_candidate_accepted_as_authoritative_signal");

    result.kind = "entity_specific";
    result.confidence = Math.max(
      0.8,
      Math.min(0.96, Number(explicitEntityCandidate.score || 0))
    );

    result.signals.hasCatalogScope = true;
    result.signals.hasSpecificEntityCandidate = true;
    result.signals.hasVariantCandidate = false;
    result.signals.hasFamilyCandidate = false;

    result.shouldUseContextFirst = false;
    result.shouldResolvePluralCatalog = false;
    result.shouldResolveFamily = false;
    result.shouldResolveEntity = true;
    result.shouldResolveVariant = false;
    result.shouldAskDisambiguation = false;

    result.targetLevel = "service";
    result.targetServiceId =
      String(explicitEntityCandidate.id || "").trim() || null;
    result.targetServiceName =
      String(explicitEntityCandidate.name || "").trim() || null;

    result.targetVariantId = null;
    result.targetVariantName = null;
    result.targetFamilyKey = null;
    result.targetFamilyName = null;

    if (result.intent === "unknown") {
      result.intent = "price_or_plan";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 3) EXPLICIT FAMILY CANDIDATE
  // =========================================================
  if (explicitFamilyCandidate?.familyKey) {
    notes.push("explicit_family_candidate");
    notes.push(
      `explicit_family_score:${Number(explicitFamilyCandidate.score || 0)}`
    );

    result.kind = "catalog_family";
    result.confidence = Math.max(
      0.76,
      Math.min(0.94, Number(explicitFamilyCandidate.score || 0))
    );

    result.signals.hasCatalogScope = true;
    result.signals.hasSpecificEntityCandidate = false;
    result.signals.hasVariantCandidate = false;
    result.signals.hasFamilyCandidate = true;

    result.shouldUseContextFirst = false;
    result.shouldResolveFamily = true;

    result.targetLevel = "family";
    result.targetFamilyKey =
      String(explicitFamilyCandidate.familyKey || "").trim() || null;
    result.targetFamilyName =
      String(explicitFamilyCandidate.familyName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = "price_or_plan";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 4) EXPECTING VARIANT FROM CONTEXT
  // =========================================================
  if (hasExpectedVariant && tokenCount > 0 && tokenCount <= 6) {
    notes.push("context_expected_variant");
    notes.push("short_turn_variant_resolution");

    result.kind = "variant_specific";
    result.confidence = 0.9;

    result.shouldUseContextFirst = true;
    result.shouldResolveVariant = true;

    result.targetLevel = "variant";
    result.targetServiceId =
      String(context.expectingVariantForEntityId || "").trim() || null;
    result.targetServiceName =
      String(context.lastEntityName || "").trim() || null;

    result.targetVariantId = null;
    result.targetVariantName = null;

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 5) REFERENTIAL FOLLOW-UP WITH ENTITY CONTEXT
  // Solo si hay follow-up claro sobre una entidad/familia activa.
  // info_general NO debe promover catálogo por sí solo.
  // =========================================================
  if (
    canUseEntityContextAsClearFollowup({
      detectedIntent,
      tokenCount,
      hasExpectedVariant,
      hasLastEntity,
      hasPresentedEntities,
      hasLastFamily,
      hasPresentedFamilies,
      signals,
    }) &&
    (hasPresentedEntities || hasLastEntity)
  ) {
    notes.push("clear_followup_with_entity_context");
    notes.push("entity_context_followup_allowed");

    result.kind = "referential_followup";
    result.confidence = hasPresentedEntities ? 0.84 : 0.78;

    result.shouldUseContextFirst = true;
    result.shouldAskDisambiguation = context.lastPresentedEntityIds.length > 1;
    result.disambiguationType = inferDisambiguationType(context);

    result.targetLevel = hasLastEntity ? "service" : "none";
    result.targetServiceId = String(context.lastEntityId || "").trim() || null;
    result.targetServiceName =
      String(context.lastEntityName || "").trim() || null;

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 6) FAMILY CONTEXT
  // =========================================================
  if (
    !hasLastEntity &&
    (hasLastFamily || hasPresentedFamilies) &&
    tokenCount > 0 &&
    tokenCount <= 10
  ) {
    notes.push("family_context_available");
    notes.push("family_level_resolution");

    result.kind = "catalog_family";
    result.confidence = 0.76;

    result.shouldUseContextFirst = true;
    result.shouldResolveFamily = true;
    result.shouldAskDisambiguation = context.lastPresentedFamilyKeys.length > 1;
    result.disambiguationType = inferDisambiguationType(context);

    result.targetLevel = "family";
    result.targetFamilyKey = String(context.lastFamilyKey || "").trim() || null;
    result.targetFamilyName =
      String(context.lastFamilyName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = "price_or_plan";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 7) ENTITY CONTEXT WITHOUT EXPLICIT MATCH
  // Contexto viejo NO debe forzar catálogo si el turn actual
  // no trae intención catalogable clara.
  // =========================================================
  if (hasLastEntity && tokenCount > 6 && isCatalogFollowupIntent(detectedIntent)) {
    notes.push("entity_context_available");
    notes.push("longer_turn_with_entity_context");
    notes.push("catalog_followup_intent_confirmed");

    result.kind = "referential_followup";
    result.confidence = 0.66;

    result.shouldUseContextFirst = true;
    result.shouldAskDisambiguation = false;

    result.targetLevel = "service";
    result.targetServiceId = String(context.lastEntityId || "").trim() || null;
    result.targetServiceName =
      String(context.lastEntityName || "").trim() || null;

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 8) NO CONTEXT + GENERIC CATALOG OVERVIEW SIGNAL
  // =========================================================
  if (!hasAnyContext && hasGenericCatalogOverviewSignal) {
    notes.push("no_prior_context");
    notes.push("generic_catalog_overview_signal");

    result.kind = "catalog_overview";
    result.confidence = 0.7;

    result.shouldResolvePluralCatalog = true;
    result.targetLevel = "catalog";

    if (result.intent === "unknown") {
      result.intent = "price_or_plan";
    }

    result.debug.notes = notes;
    return result;
  }

  notes.push("insufficient_structural_signal");

  if (result.intent === "unknown") {
    result.intent = mapDetectedIntentToCatalogIntent(detectedIntent, "unknown");
  }

  result.debug.notes = notes;
  return result;
}