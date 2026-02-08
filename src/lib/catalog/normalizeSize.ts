export type SizeToken = "small" | "medium" | "large" | "xl";

export function inferSizeTokenFromText(text: string): SizeToken | null {
  const q = String(text || "").toLowerCase();

  // small
  if (/\b(pequeño|pequeno|chico|toy|mini|xs|x-small|small)\b/.test(q)) return "small";
  // medium
  if (/\b(mediano|medio|med|medium)\b/.test(q)) return "medium";
  // large
  if (/\b(grande|large|lg)\b/.test(q)) return "large";
  // xl
  if (/\b(extra\s*large|x-large|xl)\b/.test(q)) return "xl";

  return null;
}

export function inferWeightLbsFromText(text: string): number | null {
  const q = String(text || "").toLowerCase();

  // "20 lbs", "20lb", "20 libras"
  const m = q.match(/\b([0-9]{1,3})\s*(lb|lbs|libras)\b/);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
