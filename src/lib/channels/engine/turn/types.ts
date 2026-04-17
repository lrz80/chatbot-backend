//src/lib/channels/engine/turn/types.ts
export type VisualTurnEvidence = {
  hasVisualReference: boolean;
  extractedText: string[];
  confidence: number;
  source: 'vision' | 'none';
};

export type CatalogTurnAugmentation = {
  rawUserText: string;
  captionText: string | null;
  visualEvidence: VisualTurnEvidence | null;
  catalogResolvableText: string;
  hasVisualCatalogContext: boolean;
};