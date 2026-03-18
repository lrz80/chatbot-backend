import type {
  CatalogReferenceClassification,
  CatalogReferenceClassificationInput,
  CatalogReferenceContext,
  CatalogReferenceSignals,
} from "./types";

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
    lastPresentedEntityIds: Array.isArray(context?.lastPresentedEntityIds)
      ? context.lastPresentedEntityIds.filter((v): v is string => Boolean(v))
      : [],
    lastPresentedFamilyKeys: Array.isArray(context?.lastPresentedFamilyKeys)
      ? context.lastPresentedFamilyKeys.filter((v): v is string => Boolean(v))
      : [],
    expectingVariantForEntityId: context?.expectingVariantForEntityId ?? null,
  };
}

function tokenizeUserText(input: string): string[] {
  return normalizeUserText(input)
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildSignals(params: {
  userText: string;
  context: CatalogReferenceContext;
}): CatalogReferenceSignals {
  const { userText, context } = params;

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
    ((hasLastEntity || hasPresentedEntities) && tokens.length <= 6);

  const hasSpecificEntityCandidate =
    hasLastEntity && tokens.length > 0 && tokens.length <= 12;

  const hasVariantCandidate =
    hasExpectedVariant && tokens.length > 0 && tokens.length <= 4;

  const hasCatalogScope =
    !hasSpecificEntityCandidate &&
    !hasVariantCandidate &&
    !hasReferentialDependency &&
    !hasConversationDependency &&
    tokens.length >= 3;

  const hasDisambiguationRisk =
    context.lastPresentedEntityIds.length > 1 ||
    context.lastPresentedFamilyKeys.length > 1;

  return {
    hasCatalogScope,
    hasSpecificEntityCandidate,
    hasVariantCandidate,
    hasReferentialDependency,
    hasConversationDependency,
    hasDisambiguationRisk,
  };
}

function buildBaseClassification(
  signals: CatalogReferenceSignals
): CatalogReferenceClassification {
  return {
    kind: "none",
    confidence: 0,
    signals,
    shouldUseContextFirst: false,
    shouldResolvePluralCatalog: false,
    shouldResolveFamily: false,
    shouldResolveEntity: false,
    shouldResolveVariant: false,
    shouldAskDisambiguation: false,
    debug: {
      source: "catalog_reference_classifier",
      notes: [],
    },
  };
}

export function classifyCatalogReferenceTurn(
  input: CatalogReferenceClassificationInput
): CatalogReferenceClassification {
  const userText = normalizeUserText(input?.userText || "");
  const context = sanitizeContext(input?.context);
  const tokens = tokenizeUserText(userText);
  const signals = buildSignals({ userText, context });

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

  if (hasExpectedVariant && tokenCount > 0 && tokenCount <= 4) {
    notes.push("context_expected_variant");
    notes.push("short_turn_variant_resolution");

    result.kind = "variant_specific";
    result.confidence = 0.92;
    result.shouldUseContextFirst = true;
    result.shouldResolveVariant = true;
    result.debug.notes = notes;
    return result;
  }

  if (
    (hasPresentedEntities || hasLastEntity) &&
    tokenCount > 0 &&
    tokenCount <= 6
  ) {
    notes.push("context_entity_available");
    notes.push("short_turn_with_entity_context");

    result.kind = "referential_followup";
    result.confidence = hasPresentedEntities ? 0.84 : 0.78;
    result.shouldUseContextFirst = true;
    result.shouldAskDisambiguation = context.lastPresentedEntityIds.length > 1;
    result.debug.notes = notes;
    return result;
  }

  if (
    !hasLastEntity &&
    (hasLastFamily || hasPresentedFamilies) &&
    tokenCount > 0 &&
    tokenCount <= 10
  ) {
    notes.push("family_context_available");
    notes.push("family_level_resolution");

    result.kind = "catalog_family";
    result.confidence = 0.72;
    result.shouldUseContextFirst = true;
    result.shouldResolveFamily = true;
    result.shouldAskDisambiguation = context.lastPresentedFamilyKeys.length > 1;
    result.debug.notes = notes;
    return result;
  }

  if (hasLastEntity && tokenCount > 6) {
    notes.push("entity_context_available");
    notes.push("longer_turn_with_entity_context");

    result.kind = "entity_specific";
    result.confidence = 0.68;
    result.shouldUseContextFirst = true;
    result.shouldResolveEntity = true;
    result.debug.notes = notes;
    return result;
  }

  if (!hasAnyContext && tokenCount >= 7) {
    notes.push("no_prior_context");
    notes.push("long_turn_without_context");
    notes.push("default_to_catalog_family_for_concrete_request_without_anchor");

    result.kind = "catalog_family";
    result.confidence = 0.58;
    result.shouldResolveFamily = true;
    result.debug.notes = notes;
    return result;
  }

  if (!hasAnyContext && tokenCount >= 3) {
    notes.push("no_prior_context");
    notes.push("mid_length_turn_without_context");
    notes.push("default_to_catalog_overview_without_anchor");

    result.kind = "catalog_overview";
    result.confidence = 0.51;
    result.shouldResolvePluralCatalog = true;
    result.debug.notes = notes;
    return result;
  }

  notes.push("insufficient_structural_signal");
  result.debug.notes = notes;
  return result;
}