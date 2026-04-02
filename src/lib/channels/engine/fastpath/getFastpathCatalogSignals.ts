//src/lib/channels/engine/fastpath/getFastpathCatalogSignals.ts
import type { Pool } from "pg";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";

export type ExplicitEntityCandidate = {
  id: string;
  name: string;
  score: number;
};

export type StructuredCatalogComparisonSide = {
  key: string;
  label: string;
  serviceIds: string[];
  serviceNames: string[];
  serviceLabels: string[];
  score: number;
};

export type StructuredCatalogComparison = {
  hasComparison: boolean;
  sides: StructuredCatalogComparisonSide[];
  serviceIds: string[];
  serviceNames: string[];
  serviceLabels: string[];
  requiresDisambiguation: boolean;
};

export type StructuredCatalogFamily = {
  hasFamily: boolean;
  familyKey: string;
  familyLabel: string;
  serviceIds: string[];
  serviceNames: string[];
  serviceLabels: string[];
  requiresDisambiguation: boolean;
};

export type ExplicitFamilyCandidate = {
  familyKey: string;
  familyLabel: string;
  serviceIds: string[];
  serviceNames: string[];
  serviceLabels: string[];
};

export type GetFastpathCatalogSignalsInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  convoCtx: any;
  previewClassification: any;
  previewPolicy: {
    shouldAllowLooseResolution: boolean;
    shouldAllowExplicitEntityPromotion: boolean;
    shouldBuildComparison: boolean;
  };
};

export type GetFastpathCatalogSignalsResult = {
  explicitEntityCandidateForClassification: ExplicitEntityCandidate | null;
  structuredComparison: StructuredCatalogComparison | null;
  entityCandidateResultLoose: any;
};

type ComparisonTokenStats = Map<string, number>;

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toTrimmedString(value: any): string {
  return String(value ?? "").trim();
}

function toNormalizedString(value: any): string {
  return toTrimmedString(value).toLowerCase();
}

function normalizeComparisonLabel(value: any): string {
  return toTrimmedString(value).toLowerCase();
}

function hasExplicitCatalogAnchor(previewClassification: any): boolean {
  return (
    Boolean(previewClassification?.targetServiceId) ||
    Boolean(previewClassification?.targetVariantId) ||
    Boolean(previewClassification?.targetFamilyKey)
  );
}

function isPositiveCatalogClassificationKind(kind: any): boolean {
  const normalized = toNormalizedString(kind);

  return (
    normalized === "entity_specific" ||
    normalized === "variant_specific" ||
    normalized === "catalog_family" ||
    normalized === "catalog_overview" ||
    normalized === "comparison" ||
    normalized === "referential_followup"
  );
}

function isComparisonClassificationKind(kind: any): boolean {
  return toNormalizedString(kind) === "comparison";
}

function shouldAllowLooseCatalogSignals(params: {
  previewClassification: any;
  previewPolicy: GetFastpathCatalogSignalsInput["previewPolicy"];
}): boolean {
  const { previewClassification, previewPolicy } = params;

  if (!previewPolicy.shouldAllowLooseResolution) {
    return false;
  }

  if (hasExplicitCatalogAnchor(previewClassification)) {
    return true;
  }

  return isPositiveCatalogClassificationKind(previewClassification?.kind);
}

function shouldAllowStructuredComparison(params: {
  previewClassification: any;
  previewPolicy: GetFastpathCatalogSignalsInput["previewPolicy"];
}): boolean {
  const { previewClassification, previewPolicy } = params;

  if (!previewPolicy.shouldBuildComparison) {
    return false;
  }

  return isComparisonClassificationKind(previewClassification?.kind);
}

function getCandidateComparisonTokens(candidate: any): string[] {
  const nameTokens = Array.isArray(candidate?.overlapNameTokens)
    ? candidate.overlapNameTokens
    : [];

  const supportTokens = Array.isArray(candidate?.overlapSupportTokens)
    ? candidate.overlapSupportTokens
    : [];

  const raw = nameTokens.length > 0 ? nameTokens : supportTokens;

  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const value of raw) {
    const token = toTrimmedString(value).toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

function getComparisonGroupKey(
  candidate: any,
  tokenStats: ComparisonTokenStats
): string {
  const tokens = getCandidateComparisonTokens(candidate);

  if (!tokens.length) {
    return toTrimmedString(candidate?.serviceId || candidate?.id).toLowerCase();
  }

  const sorted = [...tokens].sort((a, b) => {
    const freqDiff = (tokenStats.get(a) || 0) - (tokenStats.get(b) || 0);
    if (freqDiff !== 0) return freqDiff;

    const lenDiff = b.length - a.length;
    if (lenDiff !== 0) return lenDiff;

    return a.localeCompare(b);
  });

  return sorted[0];
}

function buildComparisonTokenStats(candidates: any[]): ComparisonTokenStats {
  const stats: ComparisonTokenStats = new Map();

  for (const candidate of candidates) {
    const tokens = getCandidateComparisonTokens(candidate);
    for (const token of tokens) {
      stats.set(token, (stats.get(token) || 0) + 1);
    }
  }

  return stats;
}

function buildComparisonSideLabel(members: any[]): string {
  const names = members
    .map((m) => toTrimmedString(m?.label || m?.name || m?.serviceName))
    .filter(Boolean);

  if (!names.length) return "";

  const shortest = [...names].sort((a, b) => a.length - b.length)[0];
  return shortest;
}

function buildStructuredCatalogComparison(params: {
  previewPolicy: {
    shouldBuildComparison: boolean;
  };
  entityCandidateResult: any;
  explicitEntityCandidateForClassification: ExplicitEntityCandidate | null;
}): StructuredCatalogComparison | null {
  const {
    previewPolicy,
    entityCandidateResult,
    explicitEntityCandidateForClassification,
  } = params;

  if (!previewPolicy.shouldBuildComparison) {
    return null;
  }

  const rawCandidates = Array.isArray(entityCandidateResult?.candidates)
    ? entityCandidateResult.candidates
    : [];

  const fallbackCandidates = [
    entityCandidateResult?.best || null,
    entityCandidateResult?.second || null,
  ].filter(Boolean);

  const candidates =
    rawCandidates.length > 0 ? rawCandidates : fallbackCandidates;

  const tokenStats = buildComparisonTokenStats(candidates);

  const eligible = candidates
    .map((candidate: any) => {
      const id = toTrimmedString(candidate?.serviceId || candidate?.id);
      const name = toTrimmedString(
        candidate?.label || candidate?.name || candidate?.serviceName
      );
      const label = toTrimmedString(
        candidate?.label || candidate?.name || candidate?.serviceName
      );
      const score = toFiniteNumber(candidate?.score);
      const catalogRole = toTrimmedString(candidate?.catalogRole).toLowerCase();
      const exactVariantHits = toFiniteNumber(candidate?.exactVariantHits);
      const groupKey = getComparisonGroupKey(candidate, tokenStats);

      return {
        id,
        name,
        label,
        score,
        catalogRole,
        exactVariantHits,
        groupKey,
      };
    })
    .filter((candidate: any) => {
      if (!candidate.id || !candidate.name) return false;
      if (candidate.catalogRole && candidate.catalogRole !== "primary") return false;
      if (candidate.exactVariantHits > 0) return false;
      if (candidate.score < 0.25) return false;
      if (!candidate.groupKey) return false;
      return true;
    });

  if (eligible.length < 2) {
    return null;
  }

  const grouped = new Map<string, any[]>();

  for (const candidate of eligible) {
    const bucket = grouped.get(candidate.groupKey) || [];
    bucket.push(candidate);
    grouped.set(candidate.groupKey, bucket);
  }

  const allSides = Array.from(grouped.entries())
    .map(([key, members]) => {
      const orderedMembers = [...members].sort(
        (a: any, b: any) => b.score - a.score
      );

      const uniqueServiceIds: string[] = [];
      const uniqueServiceNames: string[] = [];
      const uniqueServiceLabels: string[] = [];
      const seenIds = new Set<string>();

      for (const member of orderedMembers) {
        const memberId = toTrimmedString(member?.id);
        if (!memberId || seenIds.has(memberId)) continue;

        seenIds.add(memberId);
        uniqueServiceIds.push(memberId);
        uniqueServiceNames.push(toTrimmedString(member?.name));
        uniqueServiceLabels.push(
          toTrimmedString(member?.label || member?.name)
        );
      }

      return {
        key,
        label: buildComparisonSideLabel(orderedMembers),
        score: Math.max(...orderedMembers.map((m: any) => m.score)),
        serviceIds: uniqueServiceIds,
        serviceNames: uniqueServiceNames,
        serviceLabels: uniqueServiceLabels,
      };
    })
    .filter((side) => side.serviceIds.length > 0)
    .sort((a: any, b: any) => b.score - a.score);

  if (allSides.length < 2) {
    return null;
  }

  if (
    explicitEntityCandidateForClassification &&
    toTrimmedString(explicitEntityCandidateForClassification.id)
  ) {
    const explicitId = toTrimmedString(
      explicitEntityCandidateForClassification.id
    );

    const explicitExistsInSides = allSides.some((side) =>
      side.serviceIds.includes(explicitId)
    );

    if (!explicitExistsInSides) {
      return null;
    }
  }

  const flattenedIds: string[] = [];
  const flattenedNames: string[] = [];
  const flattenedLabels: string[] = [];
  const seenFlattenedIds = new Set<string>();

  for (const side of allSides) {
    for (let i = 0; i < side.serviceIds.length; i += 1) {
      const serviceId = toTrimmedString(side.serviceIds[i]);
      if (!serviceId || seenFlattenedIds.has(serviceId)) continue;

      seenFlattenedIds.add(serviceId);
      flattenedIds.push(serviceId);
      flattenedNames.push(toTrimmedString(side.serviceNames[i]));
      flattenedLabels.push(toTrimmedString(side.serviceLabels[i]));
    }
  }

  const normalizedSideLabels = allSides
    .map((side) => normalizeComparisonLabel(side.label))
    .filter(Boolean);

  const hasMissingSideLabels = normalizedSideLabels.length !== allSides.length;

  const hasDuplicateSideLabels =
    new Set(normalizedSideLabels).size !== normalizedSideLabels.length;

  const hasOverlappingServices = allSides.some((side, sideIndex) =>
    allSides.some((otherSide, otherIndex) => {
      if (sideIndex === otherIndex) return false;

      return side.serviceIds.some((serviceId) =>
        otherSide.serviceIds.includes(serviceId)
      );
    })
  );

  return {
    hasComparison: true,
    sides: allSides,
    serviceIds: flattenedIds,
    serviceNames: flattenedNames,
    serviceLabels: allSides
      .map((side) => toTrimmedString(side.label))
      .filter(Boolean),
    requiresDisambiguation:
      hasMissingSideLabels ||
      hasDuplicateSideLabels ||
      hasOverlappingServices,
  };
}

export async function getFastpathCatalogSignals(
  input: GetFastpathCatalogSignalsInput
): Promise<GetFastpathCatalogSignalsResult> {
  const {
    pool,
    tenantId,
    userInput,
    convoCtx,
    previewClassification,
    previewPolicy,
  } = input;

  console.log("[CATALOG_SIGNALS][PREVIEW_POLICY]", {
    userInput,
    previewPolicy,
    previewClassificationKind: previewClassification?.kind ?? null,
    previewClassificationIntent: previewClassification?.intent ?? null,
  });

  let explicitEntityCandidateForClassification: ExplicitEntityCandidate | null =
    null;
  let entityCandidateResultLoose: any = null;
  let structuredComparison: StructuredCatalogComparison | null = null;

  try {
    const shouldRunLooseResolution = shouldAllowLooseCatalogSignals({
      previewClassification,
      previewPolicy,
    });

    const shouldBuildComparison = shouldAllowStructuredComparison({
      previewClassification,
      previewPolicy,
    });

    if (shouldRunLooseResolution) {
      entityCandidateResultLoose = await resolveServiceCandidatesFromText(
        pool,
        tenantId,
        userInput,
        { mode: "loose" }
      );
    }

    const resolutionKind = entityCandidateResultLoose?.kind ?? "none";
    const resolvedHit = entityCandidateResultLoose?.hit ?? null;

    console.log("[CATALOG_SIGNALS][LOOSE_RESOLUTION]", {
      userInput,
      shouldAllowLooseResolution: previewPolicy.shouldAllowLooseResolution,
      shouldBuildComparison: previewPolicy.shouldBuildComparison,
      shouldRunLooseResolution,
      resolutionKind,
      hasEntityCandidateResultLoose: Boolean(entityCandidateResultLoose),
      looseCandidateCount: Array.isArray(entityCandidateResultLoose?.candidates)
        ? entityCandidateResultLoose.candidates.length
        : 0,
    });

    if (resolutionKind === "ambiguous" && shouldBuildComparison) {
      structuredComparison = buildStructuredCatalogComparison({
        previewPolicy: {
          shouldBuildComparison,
        },
        entityCandidateResult: entityCandidateResultLoose,
        explicitEntityCandidateForClassification: null,
      });

      explicitEntityCandidateForClassification = null;
    } else if (resolutionKind === "resolved_single" && resolvedHit?.id) {
      const rawCandidates = Array.isArray(entityCandidateResultLoose?.candidates)
        ? entityCandidateResultLoose.candidates
        : [];

      const matchedCandidate =
        rawCandidates.find(
          (candidate: any) =>
            toTrimmedString(candidate?.serviceId || candidate?.id) ===
            toTrimmedString(resolvedHit.id)
        ) || null;

      explicitEntityCandidateForClassification = {
        id: toTrimmedString(resolvedHit.id),
        name: toTrimmedString(resolvedHit.name),
        score: toFiniteNumber(matchedCandidate?.score),
      };

      structuredComparison = null;
    } else {
      explicitEntityCandidateForClassification = null;
      structuredComparison = null;
    }

    const debugCandidates = Array.isArray(entityCandidateResultLoose?.candidates)
      ? entityCandidateResultLoose.candidates
      : [];

    console.log("[CATALOG_COMPARISON][CANDIDATES]", {
      userInput,
      resolutionKind,
      candidates: debugCandidates.map((candidate: any) => ({
        serviceId: candidate?.serviceId || candidate?.id || null,
        id: candidate?.id || null,
        label: candidate?.label || candidate?.name || null,
        name: candidate?.name || null,
        score: candidate?.score || null,
        catalogRole: candidate?.catalogRole || null,
        exactNameHits: candidate?.exactNameHits || 0,
        exactVariantHits: candidate?.exactVariantHits || 0,
      })),
      explicitEntityCandidateForClassification,
      structuredComparison,
    });
  } catch (e: any) {
    console.warn(
      "[CATALOG_REFERENCE_CLASSIFIER][EXPLICIT_ENTITY_CANDIDATE] failed:",
      e?.message || e
    );
  }

  return {
    explicitEntityCandidateForClassification,
    structuredComparison,
    entityCandidateResultLoose,
  };
}