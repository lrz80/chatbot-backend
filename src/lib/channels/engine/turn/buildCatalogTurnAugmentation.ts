//src/lib/channels/engine/turn/buildCatalogTurnAugmentation.ts
import type { CatalogTurnAugmentation, VisualTurnEvidence } from './types';

type BuildCatalogTurnAugmentationInput = {
  userText: string | null | undefined;
  captionText?: string | null;
  visualEvidence?: VisualTurnEvidence | null;
};

function cleanLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function uniqNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const v = cleanLine(value);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  return out;
}

export function buildCatalogTurnAugmentation(
  input: BuildCatalogTurnAugmentationInput
): CatalogTurnAugmentation {
  const rawUserText = cleanLine(input.userText ?? '');
  const captionText = cleanLine(input.captionText ?? '') || null;
  const visualEvidence = input.visualEvidence ?? null;

  const observedText = uniqNonEmpty(visualEvidence?.extractedText ?? []);
  const hasVisualCatalogContext = Boolean(
    visualEvidence?.hasVisualReference && observedText.length > 0
  );

  const parts = uniqNonEmpty([
    rawUserText,
    captionText ?? '',
    ...observedText.map((value) => `Referencia visual observada: ${value}`),
  ]);

  return {
    rawUserText,
    captionText,
    visualEvidence,
    catalogResolvableText: parts.join('\n'),
    hasVisualCatalogContext,
  };
}