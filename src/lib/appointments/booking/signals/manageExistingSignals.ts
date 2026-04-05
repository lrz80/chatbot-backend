import { normalizeText } from "../shared/textCore";

export type ManageExistingAction = "cancel" | "reschedule";

const MANAGE_EXISTING_PHRASES = [
  "cancel appointment",
  "cancel booking",
  "reschedule appointment",
  "reschedule booking",
  "change appointment",
  "move appointment",
  "cancel",
  "reschedule",
  "change booking",
];

const CANCEL_PHRASES = [
  "cancel",
  "cancel appointment",
  "cancel booking",
];

const RESCHEDULE_PHRASES = [
  "reschedule",
  "reschedule appointment",
  "reschedule booking",
  "change appointment",
  "change booking",
  "move appointment",
  "move booking",
];

export function wantsManageExisting(text: string): boolean {
  const t = normalizeText(text);
  return hasAnyPhrase(t, MANAGE_EXISTING_PHRASES);
}

export function detectManageExistingAction(
  text: string
): ManageExistingAction | null {
  const t = normalizeText(text);

  if (hasAnyPhrase(t, CANCEL_PHRASES)) return "cancel";
  if (hasAnyPhrase(t, RESCHEDULE_PHRASES)) return "reschedule";

  return null;
}

function hasAnyPhrase(text: string, phrases: string[]): boolean {
  for (const phrase of phrases) {
    const normalized = normalizeText(phrase);
    if (!normalized) continue;

    if (!normalized.includes(" ")) {
      const parts = text.split(" ").filter(Boolean);
      if (parts.includes(normalized)) return true;
      continue;
    }

    if (
      text === normalized ||
      text.startsWith(`${normalized} `) ||
      text.endsWith(` ${normalized}`) ||
      text.includes(` ${normalized} `)
    ) {
      return true;
    }
  }

  return false;
}