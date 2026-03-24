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
  return normalizeUserText(input)
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function mapDetectedIntentToCatalogIntent(
  detectedIntent: string | null,
  fallback: CatalogReferenceIntent = "unknown"
): CatalogReferenceIntent {
  const value = String(detectedIntent || "").trim();

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

    default:
      return fallback;
  }
}

function inferIntentFromContext(params: {
  detectedIntent: string | null;
  context: CatalogReferenceContext;
  explicitEntityCandidate: CatalogReferenceClassificationInput["explicitEntityCandidate"];
  explicitFamilyCandidate: CatalogReferenceClassificationInput["explicitFamilyCandidate"];
  explicitVariantCandidate: CatalogReferenceClassificationInput["explicitVariantCandidate"];
}): CatalogReferenceIntent {
  const mapped = mapDetectedIntentToCatalogIntent(params.detectedIntent, "unknown");
  if (mapped !== "unknown") return mapped;

  const { context, explicitEntityCandidate, explicitFamilyCandidate, explicitVariantCandidate } = params;

  if (explicitVariantCandidate?.variantId) {
    return context.expectedVariantIntent || "includes";
  }

  if (explicitEntityCandidate?.id) {
    return context.lastResolvedIntent || "includes";
  }

  if (explicitFamilyCandidate?.familyKey) {
    return "price_or_plan";
  }

  if (context.expectedVariantIntent) {
    return context.expectedVariantIntent;
  }

  if (context.lastResolvedIntent) {
    return context.lastResolvedIntent;
  }

  if (context.expectingVariantForEntityId) {
    return "includes";
  }

  if (context.lastEntityId) {
    return "unknown";
  }

  if (context.lastFamilyKey) {
    return "price_or_plan";
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
  const { userText, context, explicitEntityCandidate, explicitFamilyCandidate, explicitVariantCandidate } = params;

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
    ((hasLastEntity || hasPresentedEntities || hasLastFamily || hasPresentedFamilies) &&
      tokens.length > 0 &&
      tokens.length <= 6);

  const hasSpecificEntityCandidate = Boolean(explicitEntityCandidate?.id);
  const hasVariantCandidate = Boolean(explicitVariantCandidate?.variantId);
  const hasFamilyCandidate = Boolean(explicitFamilyCandidate?.familyKey);

  const hasCatalogScope =
    !hasSpecificEntityCandidate &&
    !hasVariantCandidate &&
    !hasFamilyCandidate &&
    !hasReferentialDependency &&
    !hasConversationDependency &&
    false;

  const hasDisambiguationRisk =
    context.lastPresentedEntityIds.length > 1 ||
    context.lastPresentedFamilyKeys.length > 1 ||
    (Array.isArray(context.presentedVariantOptions) && context.presentedVariantOptions.length > 1);

  const hasAnchorShift =
    (hasSpecificEntityCandidate &&
      hasLastEntity &&
      String(explicitEntityCandidate?.id || "").trim() !== String(context.lastEntityId || "").trim()) ||
    (hasFamilyCandidate &&
      hasLastFamily &&
      String(explicitFamilyCandidate?.familyKey || "").trim() !== String(context.lastFamilyKey || "").trim()) ||
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

function inferDisambiguationType(context: CatalogReferenceContext): CatalogDisambiguationType {
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
  const { context, explicitEntityCandidate, explicitFamilyCandidate, explicitVariantCandidate, signals } = params;

  if (explicitVariantCandidate?.variantId) {
    return context.expectingVariantForEntityId ? "switch_variant" : "stay_on_anchor";
  }

  if (explicitEntityCandidate?.id) {
    if (
      context.lastEntityId &&
      String(explicitEntityCandidate.id || "").trim() !== String(context.lastEntityId || "").trim()
    ) {
      return "switch_entity";
    }
    return "stay_on_anchor";
  }

  if (explicitFamilyCandidate?.familyKey) {
    if (
      context.lastFamilyKey &&
      String(explicitFamilyCandidate.familyKey || "").trim() !== String(context.lastFamilyKey || "").trim()
    ) {
      return "switch_family";
    }
    return "stay_on_anchor";
  }

  if (signals.hasCatalogScope) return "browse_catalog";

  return "none";
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
    "info_horarios_generales",
    "other_plans",
    "catalog_alternatives",
    "combination_and_price",
    "catalog_combination",
  ]);

  if (detectedIntent && !catalogCapableIntents.has(detectedIntent)) {
    notes.push(`non_catalog_intent:${detectedIntent}`);
    result.debug.notes = notes;
    return result;
  }

  result.intent = inferIntentFromContext({
    detectedIntent,
    context,
    explicitEntityCandidate,
    explicitFamilyCandidate,
    explicitVariantCandidate,
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
  // 1) EXPLICIT VARIANT CANDIDATE
  // =========================================================
  if (explicitVariantCandidate?.variantId) {
    notes.push("explicit_variant_candidate");
    notes.push(`explicit_variant_score:${Number(explicitVariantCandidate.score || 0)}`);

    result.kind = "variant_specific";
    result.confidence = Math.max(0.82, Math.min(0.97, Number(explicitVariantCandidate.score || 0)));

    result.shouldUseContextFirst = false;
    result.shouldResolveVariant = true;

    result.targetLevel = "variant";

    result.targetVariantId = String(explicitVariantCandidate.variantId || "").trim() || null;
    result.targetVariantName = String(explicitVariantCandidate.label || "").trim() || null;

    result.targetServiceId = String(explicitVariantCandidate.serviceId || "").trim() || null;
    result.targetServiceName = String(explicitVariantCandidate.serviceName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = context.expectedVariantIntent || context.lastResolvedIntent || "includes";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 2) EXPLICIT ENTITY CANDIDATE
  // =========================================================
  if (explicitEntityCandidate?.id) {
    notes.push("explicit_entity_candidate_from_catalog_matcher");
    notes.push(`explicit_entity_score:${Number(explicitEntityCandidate.score || 0)}`);

    result.kind = "entity_specific";
    result.confidence = Math.max(0.8, Math.min(0.96, Number(explicitEntityCandidate.score || 0)));

    result.signals.hasSpecificEntityCandidate = true;

    result.shouldUseContextFirst = false;
    result.shouldResolveEntity = true;

    result.targetLevel = "service";

    result.targetServiceId = String(explicitEntityCandidate.id || "").trim() || null;
    result.targetServiceName = String(explicitEntityCandidate.name || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = context.lastResolvedIntent || "includes";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 3) EXPLICIT FAMILY CANDIDATE
  // =========================================================
  if (explicitFamilyCandidate?.familyKey) {
    notes.push("explicit_family_candidate");
    notes.push(`explicit_family_score:${Number(explicitFamilyCandidate.score || 0)}`);

    result.kind = "catalog_family";
    result.confidence = Math.max(0.76, Math.min(0.94, Number(explicitFamilyCandidate.score || 0)));

    result.shouldUseContextFirst = false;
    result.shouldResolveFamily = true;

    result.targetLevel = "family";
    result.targetFamilyKey = String(explicitFamilyCandidate.familyKey || "").trim() || null;
    result.targetFamilyName = String(explicitFamilyCandidate.familyName || "").trim() || null;

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
    result.targetServiceId = String(context.expectingVariantForEntityId || "").trim() || null;
    result.targetServiceName = String(context.lastEntityName || "").trim() || null;

    // ✅ NO asumir primera variante
    result.targetVariantId = null;
    result.targetVariantName = null;

    if (result.intent === "unknown") {
      result.intent = context.expectedVariantIntent || "includes";
    }

    result.debug.notes = notes;
    return result;
  }


  // =========================================================
  // 5) REFERENTIAL FOLLOW-UP WITH ENTITY CONTEXT
  // =========================================================
  if (
    (hasPresentedEntities || hasLastEntity) &&
    tokenCount > 0 &&
    tokenCount <= 6 &&
    (
      signals.hasReferentialDependency ||
      signals.hasSpecificEntityCandidate ||
      signals.hasVariantCandidate ||
      signals.hasFamilyCandidate ||
      context.expectingVariantForEntityId
    )
  ) {
    notes.push("context_entity_available");
    notes.push("short_turn_with_entity_context");

    result.kind = "referential_followup";
    result.confidence = hasPresentedEntities ? 0.84 : 0.78;

    result.shouldUseContextFirst = true;
    result.shouldAskDisambiguation = context.lastPresentedEntityIds.length > 1;
    result.disambiguationType = inferDisambiguationType(context);

    result.targetLevel = hasLastEntity ? "service" : "none";
    result.targetServiceId = String(context.lastEntityId || "").trim() || null;
    result.targetServiceName = String(context.lastEntityName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = context.lastResolvedIntent || "unknown";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 6) FAMILY CONTEXT
  // =========================================================
  if (!hasLastEntity && (hasLastFamily || hasPresentedFamilies) && tokenCount > 0 && tokenCount <= 10) {
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
    result.targetFamilyName = String(context.lastFamilyName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = "price_or_plan";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 7) ENTITY CONTEXT WITHOUT EXPLICIT MATCH
  //    ✅ NO arrastrar entity_specific solo por longitud
  // =========================================================
  if (hasLastEntity && tokenCount > 6) {
    notes.push("entity_context_available");
    notes.push("longer_turn_with_entity_context");
    notes.push("prefer_referential_followup_over_forced_entity_specific");

    result.kind = "referential_followup";
    result.confidence = 0.66;

    result.shouldUseContextFirst = true;
    result.shouldAskDisambiguation = false;

    result.targetLevel = "service";
    result.targetServiceId = String(context.lastEntityId || "").trim() || null;
    result.targetServiceName = String(context.lastEntityName || "").trim() || null;

    if (result.intent === "unknown") {
      result.intent = context.lastResolvedIntent || "unknown";
    }

    result.debug.notes = notes;
    return result;
  }

  // =========================================================
  // 8) NO CONTEXT + EXPLICIT CATALOG BROWSE ONLY
  //    ✅ no usar longitud como proxy de catálogo
  // =========================================================
  if (!hasAnyContext && isExplicitCatalogBrowseIntent(detectedIntent)) {
    notes.push("no_prior_context");
    notes.push("explicit_catalog_browse_intent");

    result.kind = "catalog_overview";
    result.confidence = 0.62;

    result.shouldResolvePluralCatalog = true;
    result.targetLevel = "catalog";

    if (result.intent === "unknown") {
      result.intent = mapDetectedIntentToCatalogIntent(detectedIntent, "price_or_plan");
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