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

function normalizeComparisonLabel(value: any): string {
  return toTrimmedString(value).toLowerCase();
}

function isEntityCandidateAnchoredToContext(params: {
  matchedCandidate: any;
  convoCtx: any;
}): boolean {
  const candidateId = toTrimmedString(
    params.matchedCandidate?.serviceId || params.matchedCandidate?.id
  );

  if (!candidateId) return false;

  const directIds = [
    params.convoCtx?.last_service_id,
    params.convoCtx?.selectedServiceId,
    params.convoCtx?.selected_service_id,
  ]
    .map((value) => toTrimmedString(value))
    .filter(Boolean);

  if (directIds.includes(candidateId)) {
    return true;
  }

  const presentedIds = Array.isArray(params.convoCtx?.lastPresentedEntityIds)
    ? params.convoCtx.lastPresentedEntityIds
    : Array.isArray(params.convoCtx?.last_presented_entity_ids)
    ? params.convoCtx.last_presented_entity_ids
    : [];

  return presentedIds.some(
    (id: any) => toTrimmedString(id) === candidateId
  );
}

function canPromoteResolvedHitAsExplicitEntity(params: {
  matchedCandidate: any;
  allCandidates: any[];
  previewClassification: any;
  convoCtx: any;
  previewPolicy: {
    shouldAllowExplicitEntityPromotion: boolean;
  };
}): boolean {
  const {
    matchedCandidate,
    allCandidates,
    previewClassification,
    convoCtx,
    previewPolicy,
  } = params;

  if (!matchedCandidate) return false;
  if (!previewPolicy.shouldAllowExplicitEntityPromotion) return false;

  const score = toFiniteNumber(matchedCandidate?.score);
  const exactNameHits = toFiniteNumber(matchedCandidate?.exactNameHits);
  const exactVariantHits = toFiniteNumber(matchedCandidate?.exactVariantHits);
  const dominantOverlapCount = toFiniteNumber(
    matchedCandidate?.dominantOverlapCount
  );

  if (
    isEntityCandidateAnchoredToContext({
      matchedCandidate,
      convoCtx,
    })
  ) {
    return true;
  }

  const signals = previewClassification?.signals || {};
  const hasConversationDependency =
    Boolean(signals?.hasReferentialDependency) ||
    Boolean(signals?.hasConversationDependency);

  if (exactVariantHits >= 1) return true;
  if (exactNameHits >= 2) return true;
  if (dominantOverlapCount >= 2 && score >= 0.82) return true;

  if (
    hasConversationDependency &&
    score >= 0.72 &&
    (exactNameHits >= 1 || dominantOverlapCount >= 1)
  ) {
    return true;
  }

  const sorted = Array.isArray(allCandidates)
    ? [...allCandidates]
        .map((candidate) => ({
          ...candidate,
          score: toFiniteNumber(candidate?.score),
        }))
        .sort((a, b) => b.score - a.score)
    : [];

  const secondScore = sorted.length > 1 ? toFiniteNumber(sorted[1]?.score) : 0;
  const scoreGap = score - secondScore;

  return score >= 0.9 && scoreGap >= 0.25;
}

function getCandidateComparisonTokens(candidate: any): string[] {
  const nameTokens = Array.isArray(candidate?.overlapNameTokens)
    ? candidate.overlapNameTokens
    : [];

  const supportTokens = Array.isArray(candidate?.overlapSupportTokens)
    ? candidate.overlapSupportTokens
    : [];

  // Para comparar entidades, primero usa tokens realmente discriminativos
  // del nombre. Solo cae a support tokens si no hay name tokens.
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

  // Para separar lados de una comparación, conviene el token MENOS compartido,
  // no el más frecuente.
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

  let explicitEntityCandidateForClassification: ExplicitEntityCandidate | null =
    null;
  let entityCandidateResultLoose: any = null;
  let structuredComparison: StructuredCatalogComparison | null = null;

  try {
    if (previewPolicy.shouldAllowLooseResolution) {
      entityCandidateResultLoose = await resolveServiceCandidatesFromText(
        pool,
        tenantId,
        userInput,
        { mode: "loose" }
      );
    }

    const resolvedHit = entityCandidateResultLoose?.hit ?? null;

    if (resolvedHit?.id) {
      const rawCandidates = Array.isArray(entityCandidateResultLoose?.candidates)
        ? entityCandidateResultLoose.candidates
        : [];

      const fallbackCandidates = [
        entityCandidateResultLoose?.best || null,
        entityCandidateResultLoose?.second || null,
      ].filter(Boolean);

      const candidatesForMatch =
        rawCandidates.length > 0 ? rawCandidates : fallbackCandidates;

      const matchedCandidate =
        candidatesForMatch.find(
          (candidate: any) =>
            toTrimmedString(candidate?.serviceId || candidate?.id) ===
            toTrimmedString(resolvedHit.id)
        ) || null;

      const canPromoteExplicitEntity = canPromoteResolvedHitAsExplicitEntity({
        matchedCandidate,
        allCandidates: candidatesForMatch,
        previewClassification,
        convoCtx,
        previewPolicy,
      });

      if (canPromoteExplicitEntity) {
        explicitEntityCandidateForClassification = {
          id: toTrimmedString(resolvedHit.id),
          name: toTrimmedString(resolvedHit.name),
          score: toFiniteNumber(matchedCandidate?.score),
        };
      }
    }

    structuredComparison = buildStructuredCatalogComparison({
      previewPolicy,
      entityCandidateResult: entityCandidateResultLoose,
      explicitEntityCandidateForClassification,
    });

    if (structuredComparison?.hasComparison) {
      explicitEntityCandidateForClassification = null;
    }

    const debugRawCandidates = Array.isArray(entityCandidateResultLoose?.candidates)
      ? entityCandidateResultLoose.candidates
      : [];

    const debugFallbackCandidates = [
      entityCandidateResultLoose?.best || null,
      entityCandidateResultLoose?.second || null,
    ].filter(Boolean);

    const debugCandidates =
      debugRawCandidates.length > 0
        ? debugRawCandidates
        : debugFallbackCandidates;

    console.log("[CATALOG_COMPARISON][CANDIDATES]", {
      userInput,
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