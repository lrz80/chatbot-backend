import type { Lang } from "../../channels/engine/clients/clientDb";

/**
 * Normaliza labels de variantes en ES/EN de forma GENÉRICA (multi-tenant).
 * - No asume industria.
 * - Solo traduce tokens comunes que aparecen en catálogos (sizes, animals, up to).
 * - Si no reconoce, devuelve el label original (fail-safe).
 */
export function normalizeVariantLabel(label: string, lang: Lang): string {
  let s = String(label || "").trim();
  if (!s) return lang === "es" ? "Opción" : "Option";

  // Limpieza universal
  s = s.replace(/\s+/g, " ").trim();

  if (lang !== "es") return s;

  // Traducciones genéricas (no negocio)
  // Animales comunes (si aparecen)
  s = s
    .replace(/\bDogs\b/gi, "Perros")
    .replace(/\bDog\b/gi, "Perro")
    .replace(/\bCats\b/gi, "Gatos")
    .replace(/\bCat\b/gi, "Gato");

  // Conectores/frasings comunes
  s = s
    .replace(/\bUp to\b/gi, "hasta")
    .replace(/\bfrom\b/gi, "desde");

  // Sizes comunes (si aparecen)
  s = s
    .replace(/\bX-?Large\b/gi, "Extra grande")
    .replace(/\bXL\b/gi, "Extra grande")
    .replace(/\bLarge\b/gi, "Grande")
    .replace(/\bMedium\b/gi, "Mediano")
    .replace(/\bSmall\b/gi, "Pequeño")
    .replace(/\bX-?Small\b/gi, "Extra pequeño")
    .replace(/\bXS\b/gi, "Extra pequeño");

  // Limpieza opcional: remover prefijos "Perros - " / "Gatos - "
  s = s.replace(/^(Perros|Gatos)\s*-\s*/i, "");

  // Última limpieza
  s = s.replace(/\s+/g, " ").trim();

  return s;
}
