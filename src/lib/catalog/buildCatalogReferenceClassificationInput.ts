// src/lib/catalog/buildCatalogReferenceClassificationInput.ts
import type { CatalogReferenceClassificationInput } from "./types";
import { buildCatalogReferenceContext } from "./buildCatalogReferenceContext";

type BuildCatalogReferenceClassificationInputArgs = {
  userText: string;
  convoCtx: unknown;

  catalogReferenceIntent?: CatalogReferenceClassificationInput["catalogReferenceIntent"];
  isCatalogOverviewIntent?: boolean;
  routingHints?: CatalogReferenceClassificationInput["routingHints"];

  explicitEntityCandidate?: CatalogReferenceClassificationInput["explicitEntityCandidate"];
  explicitVariantCandidate?: CatalogReferenceClassificationInput["explicitVariantCandidate"];
  explicitFamilyCandidate?: CatalogReferenceClassificationInput["explicitFamilyCandidate"];
  structuredComparison?: CatalogReferenceClassificationInput["structuredComparison"];
};

function normalizeUserText(input: string): string {
  return String(input || "").trim();
}

function normalizeCatalogReferenceIntent(
  input?: CatalogReferenceClassificationInput["catalogReferenceIntent"]
): CatalogReferenceClassificationInput["catalogReferenceIntent"] {
  const value = String(input || "").trim().toLowerCase();

  if (
    value === "price_or_plan" ||
    value === "other_plans" ||
    value === "combination_and_price" ||
    value === "includes" ||
    value === "schedule" ||
    value === "compare" ||
    value === "unknown"
  ) {
    return value;
  }

  return null;
}

function normalizeRoutingHints(
  input?: CatalogReferenceClassificationInput["routingHints"]
): CatalogReferenceClassificationInput["routingHints"] {
  if (!input || typeof input !== "object") {
    return null;
  }

  const catalogScope =
    input.catalogScope === "overview" || input.catalogScope === "targeted"
      ? input.catalogScope
      : "none";

  const businessInfoScope =
    input.businessInfoScope === "overview" || input.businessInfoScope === "facet"
      ? input.businessInfoScope
      : "none";

  return {
    catalogScope,
    businessInfoScope,
  };
}

export function buildCatalogReferenceClassificationInput(
  args: BuildCatalogReferenceClassificationInputArgs
): CatalogReferenceClassificationInput {
  const normalizedCatalogReferenceIntent = normalizeCatalogReferenceIntent(
    args.catalogReferenceIntent
  );

  const normalizedRoutingHints = normalizeRoutingHints(args.routingHints);

  console.log("[CATALOG_INPUT_BUILDER]", {
    userText: args.userText,
    catalogReferenceIntent: normalizedCatalogReferenceIntent,
    isCatalogOverviewIntent: args.isCatalogOverviewIntent === true,
    routingHints: normalizedRoutingHints,
    explicitEntityCandidate: args.explicitEntityCandidate ?? null,
    explicitVariantCandidate: args.explicitVariantCandidate ?? null,
    explicitFamilyCandidate: args.explicitFamilyCandidate ?? null,
    structuredComparison: args.structuredComparison ?? null,
  });

  return {
    userText: normalizeUserText(args.userText),
    context: buildCatalogReferenceContext(args.convoCtx),

    catalogReferenceIntent: normalizedCatalogReferenceIntent,
    isCatalogOverviewIntent: args.isCatalogOverviewIntent === true,
    routingHints: normalizedRoutingHints,

    explicitEntityCandidate: args.explicitEntityCandidate ?? null,
    explicitVariantCandidate: args.explicitVariantCandidate ?? null,
    explicitFamilyCandidate: args.explicitFamilyCandidate ?? null,
    structuredComparison: args.structuredComparison ?? null,
  };
}