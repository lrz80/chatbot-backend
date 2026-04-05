//src/lib/appointments/booking/shared/textCore.ts
export const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;

export function normalizeText(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s:@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeOnce(haystack: string, needle: string) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack;
  return (haystack.slice(0, idx) + " " + haystack.slice(idx + needle.length)).trim();
}

export function cleanNameCandidate(raw: string): string {
  return String(raw || "")
    .replace(/[,\|;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}