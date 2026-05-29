// src/lib/voice/booking/services/square/findSquareServiceAmbiguityFromInput.ts
import { getSquareServiceName } from "./squareServiceMatcher";

type FindSquareServiceAmbiguityFromInputParams = {
  services: any[];
  inputCandidates: string[];
  resolvedServiceName: string;
};

type FindSquareServiceAmbiguityFromInputResult =
  | {
      kind: "ambiguous";
      options: any[];
      signalTokens: string[];
      optionNames: string[];
    }
  | {
      kind: "none";
      reason: string;
      signalTokens: string[];
      optionNames?: string[];
    };

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: unknown): string[] {
  const normalized = normalizeText(value);

  if (!normalized) return [];

  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 || /^\d+$/.test(token))
    )
  );
}

function includesAllTokens(text: string, tokens: string[]): boolean {
  const textTokens = new Set(tokenize(text));

  return tokens.every((token) => textTokens.has(token));
}

function getServiceName(service: any): string {
  return String(getSquareServiceName(service) ?? "").trim();
}

export function findSquareServiceAmbiguityFromInput(
  params: FindSquareServiceAmbiguityFromInputParams
): FindSquareServiceAmbiguityFromInputResult {
  const resolvedServiceName = String(params.resolvedServiceName ?? "").trim();

  if (!resolvedServiceName) {
    return {
      kind: "none",
      reason: "EMPTY_RESOLVED_SERVICE_NAME",
      signalTokens: [],
    };
  }

  const resolvedTokens = new Set(tokenize(resolvedServiceName));

  const userTokens = Array.from(
    new Set(params.inputCandidates.flatMap((candidate) => tokenize(candidate)))
  );

  const serviceNames = params.services
    .map((service) => getServiceName(service))
    .filter(Boolean);

  const catalogTokenFrequency = new Map<string, number>();

  for (const serviceName of serviceNames) {
    const serviceTokens = new Set(tokenize(serviceName));

    for (const token of serviceTokens) {
      catalogTokenFrequency.set(token, (catalogTokenFrequency.get(token) ?? 0) + 1);
    }
  }

  const catalogSize = Math.max(serviceNames.length, 1);

  const signalTokens = userTokens.filter((token) => {
    if (!resolvedTokens.has(token)) return false;

    const frequency = catalogTokenFrequency.get(token) ?? 0;
    const ratio = frequency / catalogSize;

    if (frequency < 2) return false;
    if (ratio > 0.65) return false;

    return true;
  });

  if (signalTokens.length === 0) {
    return {
      kind: "none",
      reason: "NO_SHARED_AMBIGUITY_SIGNAL_TOKENS",
      signalTokens,
    };
  }

  const options = params.services.filter((service) => {
    const serviceName = getServiceName(service);

    if (!serviceName) return false;

    return includesAllTokens(serviceName, signalTokens);
  });

  const optionNames = options.map((service) => getServiceName(service)).filter(Boolean);

  const includesResolved = optionNames.includes(resolvedServiceName);

  if (options.length >= 2 && includesResolved) {
    return {
      kind: "ambiguous",
      options,
      signalTokens,
      optionNames,
    };
  }

  return {
    kind: "none",
    reason: "NO_MULTIPLE_OPTIONS_FOR_SIGNAL_TOKENS",
    signalTokens,
    optionNames,
  };
}

export function findSquareServiceAmbiguityFromCandidates(params: {
  services: any[];
  inputCandidates: string[];
}): FindSquareServiceAmbiguityFromInputResult {
  const userTokens = Array.from(
    new Set(params.inputCandidates.flatMap((candidate) => tokenize(candidate)))
  );

  const serviceNames = params.services
    .map((service) => getServiceName(service))
    .filter(Boolean);

  const catalogTokenFrequency = new Map<string, number>();

  for (const serviceName of serviceNames) {
    const serviceTokens = new Set(tokenize(serviceName));

    for (const token of serviceTokens) {
      catalogTokenFrequency.set(token, (catalogTokenFrequency.get(token) ?? 0) + 1);
    }
  }

  const catalogSize = Math.max(serviceNames.length, 1);

  const signalTokens = userTokens.filter((token) => {
    const frequency = catalogTokenFrequency.get(token) ?? 0;
    const ratio = frequency / catalogSize;

    if (frequency < 2) return false;
    if (ratio > 0.65) return false;

    return true;
  });

  if (signalTokens.length === 0) {
    return {
      kind: "none",
      reason: "NO_SHARED_AMBIGUITY_SIGNAL_TOKENS",
      signalTokens,
    };
  }

  const options = params.services.filter((service) => {
    const serviceName = getServiceName(service);

    if (!serviceName) return false;

    return includesAllTokens(serviceName, signalTokens);
  });

  const optionNames = options.map((service) => getServiceName(service)).filter(Boolean);

  if (options.length >= 2) {
    return {
      kind: "ambiguous",
      options,
      signalTokens,
      optionNames,
    };
  }

  return {
    kind: "none",
    reason: "NO_MULTIPLE_OPTIONS_FOR_SIGNAL_TOKENS",
    signalTokens,
    optionNames,
  };
}