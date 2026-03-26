import type { CatalogReferenceClassificationInput } from "./types";
import { buildCatalogReferenceContext } from "./buildCatalogReferenceContext";

type BuildCatalogReferenceClassificationInputArgs = {
  userText: string;
  convoCtx: unknown;
  detectedIntent?: string | null;

  explicitEntityCandidate?: CatalogReferenceClassificationInput["explicitEntityCandidate"];
  explicitVariantCandidate?: CatalogReferenceClassificationInput["explicitVariantCandidate"];
  explicitFamilyCandidate?: CatalogReferenceClassificationInput["explicitFamilyCandidate"];
  structuredComparison?: CatalogReferenceClassificationInput["structuredComparison"];
};

function normalizeUserText(input: string): string {
  return String(input || "").trim();
}

function normalizeDetectedIntent(input?: string | null): string | null {
  const value = String(input || "").trim().toLowerCase();
  return value || null;
}

export function buildCatalogReferenceClassificationInput(
  args: BuildCatalogReferenceClassificationInputArgs
): CatalogReferenceClassificationInput {
  console.log("[CATALOG_INPUT_BUILDER]", {
    userText: args.userText,
    detectedIntent: args.detectedIntent,
    explicitEntityCandidate: args.explicitEntityCandidate ?? null,
    explicitVariantCandidate: args.explicitVariantCandidate ?? null,
    explicitFamilyCandidate: args.explicitFamilyCandidate ?? null,
    structuredComparison: args.structuredComparison ?? null,
  });

  return {
    userText: normalizeUserText(args.userText),
    context: buildCatalogReferenceContext(args.convoCtx),
    detectedIntent: normalizeDetectedIntent(args.detectedIntent),

    explicitEntityCandidate: args.explicitEntityCandidate,
    explicitVariantCandidate: args.explicitVariantCandidate,
    explicitFamilyCandidate: args.explicitFamilyCandidate,
    structuredComparison: args.structuredComparison,
  };
}