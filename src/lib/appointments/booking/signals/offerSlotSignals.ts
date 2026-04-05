import { normalizeText } from "../shared/textCore";

export type OfferSlotDaypart = "morning" | "afternoon" | null;

export function detectOfferSlotDaypart(text: string): OfferSlotDaypart {
  const t = normalizeText(text);

  if (
    containsAnyPhrase(t, [
      "morning",
      "in the morning",
      "am",
      "early",
    ])
  ) {
    return "morning";
  }

  if (
    containsAnyPhrase(t, [
      "afternoon",
      "in the afternoon",
      "pm",
      "later",
      "evening",
      "night",
    ])
  ) {
    return "afternoon";
  }

  return null;
}

export function asksAvailabilityList(text: string): boolean {
  const t = normalizeText(text);

  return containsAnyPhrase(t, [
    "hours",
    "available",
    "availability",
    "openings",
    "slots",
    "times",
    "what times",
    "show times",
    "show available times",
  ]);
}

export function detectWeekdayFromCanonicalText(
  text: string,
): 1 | 2 | 3 | 4 | 5 | 6 | 7 | null {
  const t = normalizeText(text);

  if (containsAnyPhrase(t, ["monday", "mon"])) return 1;
  if (containsAnyPhrase(t, ["tuesday", "tue", "tues"])) return 2;
  if (containsAnyPhrase(t, ["wednesday", "wed", "weds"])) return 3;
  if (containsAnyPhrase(t, ["thursday", "thu", "thur", "thurs"])) return 4;
  if (containsAnyPhrase(t, ["friday", "fri"])) return 5;
  if (containsAnyPhrase(t, ["saturday", "sat"])) return 6;
  if (containsAnyPhrase(t, ["sunday", "sun"])) return 7;

  return null;
}

function containsAnyPhrase(text: string, phrases: string[]): boolean {
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