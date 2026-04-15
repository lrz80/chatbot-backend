//src/lib/channels/engine/continuation/decideTurnContinuation.ts
import type {
  CanonicalTurnSnapshot,
  ContinuationContext,
  ContinuationDecision,
  DecideTurnContinuationInput,
  TurnAutonomySignals,
} from "./types";

const DEFAULT_MAX_CONTEXT_AGE_MS = 20 * 60 * 1000;

function normalizeText(input: string): string {
  return String(input || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasDigits(input: string): boolean {
  for (const char of input) {
    if (char >= "0" && char <= "9") return true;
  }
  return false;
}

function safeDateMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isContextFresh(
  lastTurn: CanonicalTurnSnapshot | null | undefined,
  nowIso?: string,
  maxContextAgeMs: number = DEFAULT_MAX_CONTEXT_AGE_MS
): boolean {
  if (!lastTurn?.createdAt) return false;

  const createdMs = safeDateMs(lastTurn.createdAt);
  const nowMs = safeDateMs(nowIso || new Date().toISOString());

  if (createdMs == null || nowMs == null) return false;

  return nowMs - createdMs <= maxContextAgeMs;
}

function countLongTokens(tokens: string[]): number {
  return tokens.filter((token) => token.length >= 4).length;
}

function computeAutonomyScore(
  userInput: string,
  signals?: TurnAutonomySignals | null
): number {
  const normalized = normalizeText(userInput);
  const tokens = tokenize(normalized);
  const tokenCount = tokens.length;
  const longTokenCount = countLongTokens(tokens);

  let score = 0;

  if (tokenCount >= 5) score += 0.35;
  else if (tokenCount >= 3) score += 0.2;
  else if (tokenCount <= 2) score -= 0.25;

  if (longTokenCount >= 3) score += 0.2;
  else if (longTokenCount === 0) score -= 0.1;

  if (hasDigits(normalized)) score += 0.15;
  if (normalized.includes("http://") || normalized.includes("https://")) {
    score += 0.25;
  }
  if (normalized.includes("?")) score += 0.1;

  if (signals?.hasStrongStandaloneIntent) score += 0.4;
  if (signals?.hasResolvedEntity) score += 0.35;
  if (signals?.asksPrices) score += 0.2;
  if (signals?.asksSchedules) score += 0.2;
  if (signals?.asksLocation) score += 0.2;
  if (signals?.asksAvailability) score += 0.2;
  if (signals?.wantsBooking) score += 0.25;

  return Math.max(0, Math.min(1, score));
}

function hasActiveReferences(lastTurn?: CanonicalTurnSnapshot | null): boolean {
  return Boolean(
    lastTurn?.references?.serviceId ||
      lastTurn?.references?.familyId ||
      lastTurn?.references?.variantId
  );
}

function computeDependencyScore(
  userInput: string,
  continuationContext?: ContinuationContext | null
): number {
  const normalized = normalizeText(userInput);
  const tokens = tokenize(normalized);
  const tokenCount = tokens.length;
  const lastTurn = continuationContext?.lastTurn ?? null;

  let score = 0;

  if (lastTurn?.domain) score += 0.2;
  if (lastTurn?.assistantText) score += 0.15;
  if (hasActiveReferences(lastTurn)) score += 0.2;

  if (tokenCount <= 2) score += 0.35;
  else if (tokenCount <= 4) score += 0.2;

  if (!hasDigits(normalized) && tokenCount <= 4) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

export function decideTurnContinuation(
  input: DecideTurnContinuationInput
): ContinuationDecision {
  const userInput = String(input.userInput || "").trim();
  const continuationContext = input.continuationContext ?? null;
  const currentTurnSignals = input.currentTurnSignals ?? null;
  const lastTurn = continuationContext?.lastTurn ?? null;
  const maxContextAgeMs = input.maxContextAgeMs ?? DEFAULT_MAX_CONTEXT_AGE_MS;

  if (!userInput || !lastTurn?.domain) {
    return {
      shouldContinue: false,
      confidence: 0,
      targetDomain: null,
      reason: "stale_or_missing_context",
    };
  }

  const fresh = isContextFresh(lastTurn, input.nowIso, maxContextAgeMs);
  if (!fresh) {
    return {
      shouldContinue: false,
      confidence: 0.1,
      targetDomain: null,
      reason: "stale_or_missing_context",
    };
  }

  const autonomyScore = computeAutonomyScore(userInput, currentTurnSignals);
  const dependencyScore = computeDependencyScore(userInput, continuationContext);
  const continueScore = dependencyScore * 0.6 + (1 - autonomyScore) * 0.4;

  if (autonomyScore >= 0.7) {
    return {
      shouldContinue: false,
      confidence: autonomyScore,
      targetDomain: null,
      reason: "strong_standalone_turn",
    };
  }

  if (continueScore >= 0.62) {
    return {
      shouldContinue: true,
      confidence: continueScore,
      targetDomain: lastTurn.domain,
      reason: "referential_or_low_autonomy_with_active_context",
    };
  }

  if (continueScore >= 0.45 && lastTurn.domain) {
    return {
      shouldContinue: true,
      confidence: continueScore,
      targetDomain: lastTurn.domain,
      reason: "insufficient_signal_continue_previous",
    };
  }

  return {
    shouldContinue: false,
    confidence: 1 - continueScore,
    targetDomain: null,
    reason: "fresh_turn",
  };
}