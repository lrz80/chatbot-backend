//src/lib/channels/engine/continuation/types.ts
export type ActiveDomain =
  | "catalog"
  | "business_info"
  | "booking"
  | "other";

export type ActiveReferences = {
  serviceId?: string | null;
  familyId?: string | null;
  variantId?: string | null;
};

export type CanonicalSource =
  | "catalog"
  | "business_info"
  | "booking"
  | "other"
  | null;

export type CanonicalTurnSnapshot = {
  domain: ActiveDomain | null;
  references: ActiveReferences;
  intent: string | null;
  userText: string | null;
  assistantText: string | null;
  canonicalSource: CanonicalSource;
  createdAt: string;
};

export type ContinuationContext = {
  lastTurn: CanonicalTurnSnapshot | null;
};

export type TurnAutonomySignals = {
  detectedIntent?: string | null;
  hasStrongStandaloneIntent?: boolean;
  hasResolvedEntity?: boolean;
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
  wantsBooking?: boolean;
};

export type ContinuationDecisionReason =
  | "referential_or_low_autonomy_with_active_context"
  | "strong_standalone_turn"
  | "stale_or_missing_context"
  | "insufficient_signal_continue_previous"
  | "fresh_turn";

export type ContinuationDecision = {
  shouldContinue: boolean;
  confidence: number;
  targetDomain: ActiveDomain | null;
  reason: ContinuationDecisionReason;
};

export type DecideTurnContinuationInput = {
  userInput: string;
  continuationContext?: ContinuationContext | null;
  currentTurnSignals?: TurnAutonomySignals | null;
  nowIso?: string;
  maxContextAgeMs?: number;
};

export type BuildCanonicalTurnSnapshotInput = {
  domain: ActiveDomain | null;
  intent?: string | null;
  userText?: string | null;
  assistantText?: string | null;
  canonicalSource?: CanonicalSource;
  references?: ActiveReferences | null;
  createdAt?: string;
};