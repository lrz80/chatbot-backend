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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeSquareServiceSearchText(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(clean).filter(Boolean)));
}

export function getSquareServiceName(service: SquareBookableService): string {
  const explicitServiceName = clean((service as any).serviceName);
  if (explicitServiceName) return explicitServiceName;

  const itemName = clean(service.itemName);
  const variationName = clean(service.variationName);

  if (!variationName) return itemName;

  if (itemName.toLowerCase() === variationName.toLowerCase()) {
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

function scoreSquareServiceCandidate(input: string, candidate: string): number {
  const normalizedInput = normalizeSquareServiceSearchText(input);
  const normalizedCandidate = normalizeSquareServiceSearchText(candidate);

  if (!normalizedInput || !normalizedCandidate) return 0;

  if (normalizedInput === normalizedCandidate) return 1;

  const inputTokens = uniqueStrings(normalizedInput.split(" "));
  const candidateTokens = uniqueStrings(normalizedCandidate.split(" "));

  if (inputTokens.length === 0 || candidateTokens.length === 0) return 0;

  const candidateTokenSet = new Set(candidateTokens);
  const inputTokenSet = new Set(inputTokens);

  const matchedInputTokens = inputTokens.filter((token) =>
    candidateTokenSet.has(token)
  );

  const matchedCandidateTokens = candidateTokens.filter((token) =>
    inputTokenSet.has(token)
  );

  const inputCoverage = matchedInputTokens.length / inputTokens.length;
  const candidateCoverage =
    matchedCandidateTokens.length / candidateTokens.length;

  const union = new Set([...inputTokens, ...candidateTokens]);
  const jaccard = matchedInputTokens.length / Math.max(union.size, 1);

  const containsFullInput = normalizedCandidate.includes(normalizedInput);
  const containsFullCandidate = normalizedInput.includes(normalizedCandidate);

  if (containsFullInput && inputTokens.length >= 2) return 0.96;
  if (containsFullCandidate && candidateTokens.length >= 2) return 0.94;

  const hasStrongEvidence =
    matchedInputTokens.length >= 2 ||
    inputCoverage >= 0.8 ||
    candidateCoverage >= 0.8;

  if (!hasStrongEvidence) return 0;

  return inputCoverage * 0.5 + candidateCoverage * 0.35 + jaccard * 0.15;
}

function getChoiceNumberFromInput(value: string): number | null {
  const normalized = normalizeSquareServiceSearchText(value);
  const tokens = normalized.split(" ").filter(Boolean);

  const digitToken = tokens.find((token) => /^\d+$/.test(token));
  if (digitToken) {
    const parsed = Number(digitToken);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  const choiceWords: Record<string, number> = {
    primero: 1,
    primera: 1,
    uno: 1,
    one: 1,
    first: 1,

    segundo: 2,
    segunda: 2,
    dos: 2,
    two: 2,
    second: 2,

    tercero: 3,
    tercera: 3,
    tres: 3,
    three: 3,
    third: 3,

    cuarto: 4,
    cuarta: 4,
    cuatro: 4,
    four: 4,
    fourth: 4,

    quinto: 5,
    quinta: 5,
    cinco: 5,
    five: 5,
    fifth: 5,
  };

  for (const token of tokens) {
    if (choiceWords[token]) return choiceWords[token];
  }

  return null;
}

export function resolveSquareServiceFromInput(params: {
  input: string;
  services: SquareBookableService[];
  debug?: boolean;
}): SquareServiceMatch {
  const input = clean(params.input);
  const normalizedInput = normalizeSquareServiceSearchText(input);

  if (!normalizedInput) return { kind: "none" };

  const scored = params.services
    .map((service) => {
      const serviceName = getSquareServiceName(service);
      const searchText = getSquareServiceSearchText(service);
      const normalizedServiceName = normalizeSquareServiceSearchText(serviceName);
      const normalizedSearchText = normalizeSquareServiceSearchText(searchText);
      const score = scoreSquareServiceCandidate(input, searchText);

      return {
        service,
        serviceName,
        normalizedServiceName,
        normalizedSearchText,
        score,
      };
    })
    .filter((item) => item.serviceName && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.86) {
    return { kind: "none" };
  }

  const exactOrContainedMatches = scored.filter((item) => {
    return (
      item.normalizedServiceName === normalizedInput ||
      item.normalizedSearchText === normalizedInput ||
      item.normalizedServiceName.includes(normalizedInput) ||
      item.normalizedSearchText.includes(normalizedInput)
    );
  });

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
      options: exactOrContainedMatches
        .slice(0, 5)
        .map((item) => item.service),
    };
  }

  const closeMatches = scored.filter((item) => best.score - item.score < 0.08);

  if (closeMatches.length !== 1) {
    return {
      kind: "ambiguous",
      options: closeMatches.slice(0, 5).map((item) => item.service),
    };
  }

  return {
    kind: "resolved",
    service: best.service,
    serviceName: best.serviceName,
    score: best.score,
  };
}

export function resolveSquareServiceChoiceFromInput(params: {
  input: string;
  options: SquareBookableService[];
}): SquareServiceMatch {
  const input = clean(params.input);

  if (!input) return { kind: "none" };

  const choiceNumber = getChoiceNumberFromInput(input);

  if (choiceNumber) {
    const selected = params.options[choiceNumber - 1];

    if (selected) {
      return {
        kind: "resolved",
        service: selected,
        serviceName: getSquareServiceName(selected),
        score: 1,
      };
    }
  }

  return resolveSquareServiceFromInput({
    input,
    services: params.options,
  });
}