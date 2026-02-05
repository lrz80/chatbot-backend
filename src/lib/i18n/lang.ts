export type Lang = "es" | "en";
export type DetectedLang = Lang | "pt" | "und";

export function normalizeToLang(code?: string | null): Lang {
  const base = String(code || "").toLowerCase().split(/[-_]/)[0];
  return base === "en" ? "en" : "es";
}
