//src/lib/channels/engine/continuation/buildCanonicalTurnSnapshot.ts
import type {
  ActiveReferences,
  BuildCanonicalTurnSnapshotInput,
  CanonicalTurnSnapshot,
} from "./types";

function sanitizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeReferences(input?: ActiveReferences | null): ActiveReferences {
  return {
    serviceId: input?.serviceId ?? null,
    familyId: input?.familyId ?? null,
    variantId: input?.variantId ?? null,
  };
}

export function buildCanonicalTurnSnapshot(
  input: BuildCanonicalTurnSnapshotInput
): CanonicalTurnSnapshot {
  return {
    domain: input.domain ?? null,
    references: sanitizeReferences(input.references),
    intent: input.intent?.trim() || null,
    userText: sanitizeText(input.userText),
    assistantText: sanitizeText(input.assistantText),
    canonicalSource: input.canonicalSource ?? input.domain ?? "other",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}