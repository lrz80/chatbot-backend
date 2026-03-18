export type CatalogReferenceKind =
  | "catalog_overview"
  | "catalog_family"
  | "entity_specific"
  | "variant_specific"
  | "referential_followup"
  | "none";

export type CatalogReferenceSignals = {
  hasCatalogScope: boolean;
  hasSpecificEntityCandidate: boolean;
  hasVariantCandidate: boolean;
  hasReferentialDependency: boolean;
  hasConversationDependency: boolean;
  hasDisambiguationRisk: boolean;
};

export type CatalogReferenceContext = {
  lastEntityId: string | null;
  lastEntityName: string | null;
  lastFamilyKey: string | null;
  lastPresentedEntityIds: string[];
  lastPresentedFamilyKeys: string[];
  expectingVariantForEntityId: string | null;
};

export type CatalogReferenceClassificationInput = {
  userText: string;
  context: CatalogReferenceContext;
};

export type CatalogReferenceClassification = {
  kind: CatalogReferenceKind;
  confidence: number;
  signals: CatalogReferenceSignals;
  shouldUseContextFirst: boolean;
  shouldResolvePluralCatalog: boolean;
  shouldResolveFamily: boolean;
  shouldResolveEntity: boolean;
  shouldResolveVariant: boolean;
  shouldAskDisambiguation: boolean;
  debug: {
    source: "catalog_reference_classifier";
    notes: string[];
  };
};