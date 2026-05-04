//src/lib/voice/buildVoiceContinuationPrompt.ts
function normalizeVoicePrompt(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.?!…]+$/u, "").trim();
}

export function buildVoiceContinuationPrompt(input: {
  primaryText?: string | null;
  followupText?: string | null;
}) {
  const primary = normalizeVoicePrompt(input.primaryText || "");
  const followup = normalizeVoicePrompt(input.followupText || "");

  if (!primary && !followup) {
    return "";
  }

  if (!primary) {
    return followup;
  }

  if (!followup) {
    return primary;
  }

  const normalizedPrimary = stripTrailingPunctuation(primary).toLowerCase();
  const normalizedFollowup = stripTrailingPunctuation(followup).toLowerCase();

  if (normalizedPrimary === normalizedFollowup) {
    return primary;
  }

  return `${primary} ${followup}`.trim();
}