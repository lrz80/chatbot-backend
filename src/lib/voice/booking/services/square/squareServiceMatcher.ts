// src/lib/voice/booking/services/square/squareServiceMatcher.ts

import type { SquareBookableService } from "../../../../integrations/square/getSquareBookableServices";

export type SquareServiceMatch =
  | {
      kind: "resolved";
      service: SquareBookableService;
      serviceName: string;
      score: number;
    }
  | {
      kind: "ambiguous";
      options: SquareBookableService[];
    }
  | {
      kind: "none";
    };

type ScoredSquareService = {
  service: SquareBookableService;
  serviceName: string;
  normalizedServiceName: string;
  normalizedSearchText: string;
  score: number;
  matchedTokenCount: number;
  inputCoverage: number;
  candidateCoverage: number;
};

const MATCH_CONFIG = {
  strongScore: 0.86,
  closeScoreDelta: 0.08,
  minimumPartialMatchedTokens: 2,
} as const;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Normalización puramente estructural.
 *
 * No contiene:
 * - nombres de servicios;
 * - vocabulario de industrias;
 * - traducciones;
 * - nombres de tenants;
 * - equivalencias semánticas manuales.
 */
export function normalizeSquareServiceSearchText(
  value: unknown
): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map(clean)
        .filter(Boolean)
    )
  );
}

function getTokens(value: string): string[] {
  const normalized = normalizeSquareServiceSearchText(value);

  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter(Boolean)
    )
  );
}

export function getSquareServiceName(
  service: SquareBookableService
): string {
  const explicitServiceName = clean(
    (service as any).serviceName
  );

  if (explicitServiceName) {
    return explicitServiceName;
  }

  const itemName = clean(service.itemName);
  const variationName = clean(service.variationName);

  if (!variationName) {
    return itemName;
  }

  if (
    normalizeSquareServiceSearchText(itemName) ===
    normalizeSquareServiceSearchText(variationName)
  ) {
    return itemName;
  }

  return `${itemName} ${variationName}`.trim();
}

export function getSquareServiceSearchText(
  service: SquareBookableService
): string {
  return uniqueStrings([
    clean((service as any).searchText),
    getSquareServiceName(service),
    clean(service.itemName),
    clean(service.variationName),
  ]).join(" | ");
}

function scoreSquareServiceCandidateDetails(
  input: string,
  candidate: string
): Omit<
  ScoredSquareService,
  | "service"
  | "serviceName"
  | "normalizedServiceName"
  | "normalizedSearchText"
> {
  const normalizedInput =
    normalizeSquareServiceSearchText(input);

  const normalizedCandidate =
    normalizeSquareServiceSearchText(candidate);

  if (!normalizedInput || !normalizedCandidate) {
    return {
      score: 0,
      matchedTokenCount: 0,
      inputCoverage: 0,
      candidateCoverage: 0,
    };
  }

  if (normalizedInput === normalizedCandidate) {
    const tokenCount = getTokens(normalizedInput).length;

    return {
      score: 1,
      matchedTokenCount: tokenCount,
      inputCoverage: 1,
      candidateCoverage: 1,
    };
  }

  const inputTokens = getTokens(normalizedInput);
  const candidateTokens = getTokens(normalizedCandidate);

  if (
    inputTokens.length === 0 ||
    candidateTokens.length === 0
  ) {
    return {
      score: 0,
      matchedTokenCount: 0,
      inputCoverage: 0,
      candidateCoverage: 0,
    };
  }

  const inputTokenSet = new Set(inputTokens);
  const candidateTokenSet = new Set(candidateTokens);

  const matchedTokens = inputTokens.filter((token) =>
    candidateTokenSet.has(token)
  );

  const matchedTokenCount = matchedTokens.length;

  const inputCoverage =
    matchedTokenCount / inputTokens.length;

  const candidateCoverage =
    candidateTokens.filter((token) =>
      inputTokenSet.has(token)
    ).length / candidateTokens.length;

  const union = new Set([
    ...inputTokens,
    ...candidateTokens,
  ]);

  const jaccard =
    matchedTokenCount / Math.max(union.size, 1);

  const containsFullInput =
    normalizedCandidate.includes(normalizedInput);

  const containsFullCandidate =
    normalizedInput.includes(normalizedCandidate);

  /**
   * Una inclusión literal completa es evidencia estructural
   * fuerte y no depende del dominio.
   */
  if (containsFullInput) {
    return {
      score: 0.96,
      matchedTokenCount,
      inputCoverage,
      candidateCoverage,
    };
  }

  if (containsFullCandidate) {
    return {
      score: 0.94,
      matchedTokenCount,
      inputCoverage,
      candidateCoverage,
    };
  }

  /**
   * Para coincidencias parciales necesitamos evidencia
   * suficiente obtenida exclusivamente del texto real.
   */
  const hasUsableEvidence =
    matchedTokenCount >=
      MATCH_CONFIG.minimumPartialMatchedTokens ||
    inputCoverage >= 0.8 ||
    candidateCoverage >= 0.8;

  if (!hasUsableEvidence) {
    return {
      score: 0,
      matchedTokenCount,
      inputCoverage,
      candidateCoverage,
    };
  }

  return {
    score:
      inputCoverage * 0.5 +
      candidateCoverage * 0.35 +
      jaccard * 0.15,
    matchedTokenCount,
    inputCoverage,
    candidateCoverage,
  };
}

function hasUsablePartialEvidence(
  item: ScoredSquareService
): boolean {
  return (
    item.matchedTokenCount >=
    MATCH_CONFIG.minimumPartialMatchedTokens
  );
}

export function resolveSquareServiceFromInput(params: {
  input: string;
  services: SquareBookableService[];
  debug?: boolean;
}): SquareServiceMatch {
  const input = clean(params.input);

  const normalizedInput =
    normalizeSquareServiceSearchText(input);

  if (!normalizedInput) {
    return {
      kind: "none",
    };
  }

  if (!Array.isArray(params.services)) {
    return {
      kind: "none",
    };
  }

  if (params.services.length === 0) {
    return {
      kind: "none",
    };
  }

  const scored: ScoredSquareService[] =
    params.services
      .map((service) => {
        const serviceName =
          getSquareServiceName(service);

        const searchText =
          getSquareServiceSearchText(service);

        const normalizedServiceName =
          normalizeSquareServiceSearchText(
            serviceName
          );

        const normalizedSearchText =
          normalizeSquareServiceSearchText(
            searchText
          );

        const scoreDetails =
          scoreSquareServiceCandidateDetails(
            input,
            searchText
          );

        return {
          service,
          serviceName,
          normalizedServiceName,
          normalizedSearchText,
          ...scoreDetails,
        };
      })
      .filter(
        (item) =>
          Boolean(item.serviceName) &&
          item.score > 0
      )
      .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best) {
    return {
      kind: "none",
    };
  }

  /**
   * Primero verificamos coincidencias literales.
   *
   * Esta comparación utiliza exclusivamente:
   * - el input real;
   * - los nombres reales del catálogo;
   * - searchText real del provider.
   */
  const exactOrContainedMatches = scored.filter(
    (item) =>
      item.normalizedServiceName ===
        normalizedInput ||
      item.normalizedSearchText ===
        normalizedInput ||
      item.normalizedServiceName.includes(
        normalizedInput
      ) ||
      item.normalizedSearchText.includes(
        normalizedInput
      )
  );

  if (exactOrContainedMatches.length === 1) {
    const only = exactOrContainedMatches[0];

    return {
      kind: "resolved",
      service: only.service,
      serviceName: only.serviceName,
      score: only.score,
    };
  }

  if (exactOrContainedMatches.length > 1) {
    return {
      kind: "ambiguous",
      options: exactOrContainedMatches.map(
        (item) => item.service
      ),
    };
  }

  /**
   * Matching lexical fuerte.
   */
  if (
    best.score >= MATCH_CONFIG.strongScore
  ) {
    const closeMatches = scored.filter(
      (item) =>
        best.score - item.score <
        MATCH_CONFIG.closeScoreDelta
    );

    if (closeMatches.length > 1) {
      return {
        kind: "ambiguous",
        options: closeMatches.map(
          (item) => item.service
        ),
      };
    }

    return {
      kind: "resolved",
      service: best.service,
      serviceName: best.serviceName,
      score: best.score,
    };
  }

  /**
   * Matching parcial conservador.
   *
   * Si varios servicios conservan evidencia compatible,
   * devolvemos todos para que el resolver contextual
   * pueda hacer narrowing.
   */
  const partialMatches = scored.filter(
    hasUsablePartialEvidence
  );

  if (partialMatches.length === 1) {
    const only = partialMatches[0];

    return {
      kind: "resolved",
      service: only.service,
      serviceName: only.serviceName,
      score: only.score,
    };
  }

  if (partialMatches.length > 1) {
    return {
      kind: "ambiguous",
      options: partialMatches.map(
        (item) => item.service
      ),
    };
  }

  return {
    kind: "none",
  };
}

/**
 * Compatibilidad con callers existentes.
 *
 * No interpreta:
 * - números;
 * - ordinales;
 * - palabras de idiomas;
 * - nombres de servicios;
 * - posiciones en una lista.
 *
 * Simplemente vuelve a resolver la respuesta contra
 * el conjunto dinámico de opciones pendientes.
 */
export function resolveSquareServiceChoiceFromInput(params: {
  input: string;
  options: SquareBookableService[];
}): SquareServiceMatch {
  return resolveSquareServiceFromInput({
    input: params.input,
    services: params.options,
  });
}