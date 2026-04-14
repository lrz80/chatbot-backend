// src/lib/channels/engine/fastpath/getCanonicalCatalogRouteDecision.ts
import type { Pool } from "pg";
import {
  resolveServiceCandidatesFromText,
  type ResolveServiceDecision,
  type ResolveServiceCandidate,
} from "../../../services/pricing/resolveServiceIdFromText";

export type CanonicalCatalogRouteDecision = {
  shouldRouteCatalog: boolean;
  resolutionKind:
    | "resolved_single"
    | "resolved_service_variant_ambiguous"
    | "ambiguous"
    | "none";
  resolution: ResolveServiceDecision;
  resolvedServiceId: string | null;
  resolvedServiceName: string | null;
};

type Args = {
  pool: Pool;
  tenantId: string;
  userInput: string;
};

function getCandidateServiceId(
  candidate: ResolveServiceCandidate
): string | null {
  const value = String(candidate?.id || "").trim();
  return value || null;
}

function getResolvedServiceNameFromAmbiguousCandidates(
  candidates: ResolveServiceCandidate[]
): string | null {
  const variantCandidate =
    candidates.find((candidate) => candidate.candidateKind === "variant") ?? null;

  if (variantCandidate?.serviceName) {
    return String(variantCandidate.serviceName).trim() || null;
  }

  const serviceCandidate =
    candidates.find((candidate) => candidate.candidateKind !== "variant") ?? null;

  if (serviceCandidate?.name) {
    return String(serviceCandidate.name).trim() || null;
  }

  return null;
}

function normalizeCandidates(
  candidates: ResolveServiceCandidate[] | undefined | null
): ResolveServiceCandidate[] {
  return Array.isArray(candidates) ? candidates : [];
}

function getUniqueServiceIds(candidates: ResolveServiceCandidate[]): string[] {
  return Array.from(
    new Set(
      candidates
        .map((candidate) => getCandidateServiceId(candidate))
        .filter((serviceId): serviceId is string => Boolean(serviceId))
    )
  );
}

function areAllCandidatesVariants(
  candidates: ResolveServiceCandidate[]
): boolean {
  return (
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.candidateKind === "variant")
  );
}

function shouldRouteAmbiguousCatalog(
  candidates: ResolveServiceCandidate[]
): boolean {
  if (candidates.length === 0) {
    return false;
  }

  const uniqueServiceIds = getUniqueServiceIds(candidates);
  const allCandidatesAreVariants = areAllCandidatesVariants(candidates);

  // Único caso donde una ambigüedad estructural sí autoriza catálogo por sí sola:
  // el servicio ya quedó resuelto y solo faltan variantes del mismo servicio.
  if (uniqueServiceIds.length === 1 && allCandidatesAreVariants) {
    return true;
  }

  // Cualquier otra ambigüedad multi-servicio o de familia NO debe secuestrar
  // el dominio por sí sola. La entrada a catálogo debe venir por otras señales
  // canónicas del pipeline.
  return false;
}

function hasDirectCanonicalEntityEvidence(
  resolution: ResolveServiceDecision
): boolean {
  const candidates = normalizeCandidates(resolution.candidates);
  const best = candidates[0];

  if (!best) {
    return false;
  }

  const overlapNameTokens = Array.isArray(best.overlapNameTokens)
    ? best.overlapNameTokens.filter(Boolean)
    : [];

  return overlapNameTokens.length >= 1;
}

export async function getCanonicalCatalogRouteDecision(
  args: Args
): Promise<CanonicalCatalogRouteDecision> {
  const resolution = await resolveServiceCandidatesFromText(
    args.pool,
    args.tenantId,
    args.userInput,
    { mode: "loose" }
  );

  if (resolution.kind === "resolved_single") {
    const hasDirectEntityEvidence =
      hasDirectCanonicalEntityEvidence(resolution);

    if (!hasDirectEntityEvidence) {
      return {
        shouldRouteCatalog: false,
        resolutionKind: "none",
        resolution,
        resolvedServiceId: null,
        resolvedServiceName: null,
      };
    }

    return {
      shouldRouteCatalog: true,
      resolutionKind: "resolved_single",
      resolution,
      resolvedServiceId: resolution.hit?.id ?? null,
      resolvedServiceName: resolution.hit?.name ?? null,
    };
  }

  if (resolution.kind === "ambiguous") {
    const candidates = normalizeCandidates(resolution.candidates);
    const uniqueServiceIds = getUniqueServiceIds(candidates);
    const allCandidatesAreVariants = areAllCandidatesVariants(candidates);

    if (uniqueServiceIds.length === 1 && allCandidatesAreVariants) {
      return {
        shouldRouteCatalog: true,
        resolutionKind: "resolved_service_variant_ambiguous",
        resolution,
        resolvedServiceId: uniqueServiceIds[0],
        resolvedServiceName:
          getResolvedServiceNameFromAmbiguousCandidates(candidates),
      };
    }

    return {
      shouldRouteCatalog: shouldRouteAmbiguousCatalog(candidates),
      resolutionKind: "ambiguous",
      resolution,
      resolvedServiceId: null,
      resolvedServiceName: null,
    };
  }

  return {
    shouldRouteCatalog: false,
    resolutionKind: "none",
    resolution,
    resolvedServiceId: null,
    resolvedServiceName: null,
  };
}