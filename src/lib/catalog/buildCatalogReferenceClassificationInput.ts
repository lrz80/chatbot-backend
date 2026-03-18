import type { CatalogReferenceClassificationInput } from "./types";
import { buildCatalogReferenceContext } from "./buildCatalogReferenceContext";

type BuildCatalogReferenceClassificationInputArgs = {
  userText: string;
  convoCtx: unknown;
};

function normalizeUserText(input: string): string {
  return String(input || "").trim();
}

export function buildCatalogReferenceClassificationInput(
  args: BuildCatalogReferenceClassificationInputArgs
): CatalogReferenceClassificationInput {
  return {
    userText: normalizeUserText(args.userText),
    context: buildCatalogReferenceContext(args.convoCtx),
  };
}