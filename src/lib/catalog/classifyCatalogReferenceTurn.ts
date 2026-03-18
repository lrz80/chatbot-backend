import type {
  CatalogReferenceClassification,
  CatalogReferenceClassificationInput,
  CatalogReferenceContext,
  CatalogReferenceSignals,
} from "./types";

function buildEmptySignals(): CatalogReferenceSignals {
  return {
    hasCatalogScope: false,
    hasSpecificEntityCandidate: false,
    hasVariantCandidate: false,
    hasReferentialDependency: false,
    hasConversationDependency: false,
    hasDisambiguationRisk: false,
  };
}

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
      ? context!.lastPresentedEntityIds.filter(Boolean)
      : [],
    lastPresentedFamilyKeys: Array.isArray(context?.lastPresentedFamilyKeys)
      ? context!.lastPresentedFamilyKeys.filter(Boolean)
      : [],
    expectingVariantForEntityId: context?.expectingVariantForEntityId ?? null,
  };
}

export function classifyCatalogReferenceTurn(
  input: CatalogReferenceClassificationInput
): CatalogReferenceClassification {
  const userText = normalizeUserText(input?.userText || "");
  const context = sanitizeContext(input?.context);

  const signals = buildEmptySignals();

  const notes: string[] = [];

  if (!userText) {
    notes.push("empty_user_text");
  } else {
    notes.push("classifier_initialized");
  }

  if (context.lastEntityId) {
    notes.push("context_has_last_entity");
  }

  if (context.lastFamilyKey) {
    notes.push("context_has_last_family");
  }

  if (context.expectingVariantForEntityId) {
    notes.push("context_expecting_variant");
  }

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
      notes,
    },
  };
}