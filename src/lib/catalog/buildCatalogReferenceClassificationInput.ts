import type { CatalogReferenceClassificationInput } from "./types";
import { buildCatalogReferenceContext } from "./buildCatalogReferenceContext";

type BuildCatalogReferenceClassificationInputArgs = {
  userText: string;
  convoCtx: unknown;
  detectedIntent?: string | null;
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
  return {
    userText: normalizeUserText(args.userText),
    context: buildCatalogReferenceContext(args.convoCtx),
    detectedIntent: normalizeDetectedIntent(args.detectedIntent),
  };
}