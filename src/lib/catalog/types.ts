// src/lib/catalog/types.ts

export type CatalogReferenceKind =
  | "catalog_overview"
  | "catalog_family"
  | "entity_specific"
  | "variant_specific"
  | "referential_followup"
  | "none";

export type CatalogReferenceIntent =
  | "price_or_plan"
  | "other_plans"
  | "combination_and_price"
  | "includes"
  | "schedule"
  | "unknown";

export type CatalogTargetLevel =
  | "catalog"
  | "family"
  | "service"
  | "variant"
  | "none";

export type CatalogDisambiguationType =
  | "entity"
  | "family"
  | "variant"
  | "none";

export type CatalogAnchorShift =
  | "stay_on_anchor"
  | "switch_entity"
  | "switch_family"
  | "switch_variant"
  | "browse_catalog"
  | "none";

export type CatalogReferenceSignals = {
  hasCatalogScope: boolean;
  hasSpecificEntityCandidate: boolean;
  hasVariantCandidate: boolean;
  hasFamilyCandidate: boolean;
  hasReferentialDependency: boolean;
  hasConversationDependency: boolean;
  hasDisambiguationRisk: boolean;
  hasAnchorShift: boolean;
};

export type CatalogReferenceContext = {
  lastEntityId: string | null;
  lastEntityName: string | null;

  lastFamilyKey: string | null;
  lastFamilyName: string | null;

  lastPresentedEntityIds: string[];
  lastPresentedFamilyKeys: string[];

  expectingVariantForEntityId: string | null;

  // 👇 memoria estructurada para follow-ups
  lastResolvedIntent: CatalogReferenceIntent | null;
  expectedVariantIntent: CatalogReferenceIntent | null;

  presentedVariantOptions: Array<{
    index: number;
    variantId: string;
    label: string;
    aliases: string[];
  }> | null;
};

export type CatalogReferenceExplicitEntityCandidate = {
  id: string;
  name: string;
  score: number;
} | null;

export type CatalogReferenceExplicitFamilyCandidate = {
  familyKey: string;
  familyName: string;
  score: number;
} | null;

export type CatalogReferenceExplicitVariantCandidate = {
  variantId: string;
  label: string;
  score: number;
  serviceId: string | null;
  serviceName: string | null;
} | null;

export type CatalogReferenceClassificationInput = {
  userText: string;
  context: CatalogReferenceContext;

  explicitEntityCandidate?: CatalogReferenceExplicitEntityCandidate;
  explicitFamilyCandidate?: CatalogReferenceExplicitFamilyCandidate;
  explicitVariantCandidate?: CatalogReferenceExplicitVariantCandidate;

  detectedIntent?: string | null;
};

export type CatalogReferenceClassification = {
  kind: CatalogReferenceKind;
  intent: CatalogReferenceIntent;
  confidence: number;

  signals: CatalogReferenceSignals;

  shouldUseContextFirst: boolean;
  shouldResolvePluralCatalog: boolean;
  shouldResolveFamily: boolean;
  shouldResolveEntity: boolean;
  shouldResolveVariant: boolean;
  shouldAskDisambiguation: boolean;

  targetLevel: CatalogTargetLevel;

  targetServiceId: string | null;
  targetServiceName: string | null;

  targetVariantId: string | null;
  targetVariantName: string | null;

  targetFamilyKey: string | null;
  targetFamilyName: string | null;

  disambiguationType: CatalogDisambiguationType;
  anchorShift: CatalogAnchorShift;

  debug: {
    source: "catalog_reference_classifier";
    notes: string[];
  };
};