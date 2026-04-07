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

function getCandidateServiceId(candidate: ResolveServiceCandidate): string | null {
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
    return {
      shouldRouteCatalog: true,
      resolutionKind: "resolved_single",
      resolution,
      resolvedServiceId: resolution.hit?.id ?? null,
      resolvedServiceName: resolution.hit?.name ?? null,
    };
  }

  if (resolution.kind === "ambiguous") {
    const candidates = Array.isArray(resolution.candidates)
      ? resolution.candidates
      : [];

    const uniqueServiceIds = Array.from(
      new Set(
        candidates
          .map((candidate) => getCandidateServiceId(candidate))
          .filter((serviceId): serviceId is string => Boolean(serviceId))
      )
    );

    // Caso importante:
    // el servicio ya está resuelto, pero faltó escoger variante.
    // En este caso el resolver devuelve varios candidates tipo "variant"
    // con el MISMO service id en candidate.id.
    const allCandidatesAreVariants =
      candidates.length > 0 &&
      candidates.every((candidate) => candidate.candidateKind === "variant");

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
      shouldRouteCatalog: true,
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