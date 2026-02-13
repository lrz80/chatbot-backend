// src/lib/fastpath/naturalizeSecondaryOptions.ts
import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

type Args = {
  tenantId: string;
  idiomaDestino: Lang;
  canal: Canal;

  // texto base (ej: lista de planes)
  baseText: string;

  // qué “familia” se mostró
  primary: "plans" | "packages" | "services";

  // si existe algo adicional que conviene mencionar
  secondaryAvailable: boolean;

  // opcional: nombre genérico de lo secundario (no negocio-específico)
  // Ej: ["paquetes", "bundles"] o ["packages", "bundles"]
  secondaryNouns?: string[];

  // si true, no añade nada si el baseText ya termina con pregunta o instrucción
  avoidIfAlreadyHasCTA?: boolean;

  maxLines?: number; // ✅ TIENE que estar así
};

function normalizeEnd(s: string) {
  return String(s || "").trim().replace(/\s+$/g, "");
}

function hasCTAOrQuestion(s: string) {
  const t = normalizeEnd(s);
  // Si ya cierra con pregunta o CTA típico, no lo ensucies
  return /\?\s*$/.test(t) || /\b(responde|reply|elige|choose|dime|tell me)\b/i.test(t);
}

function buildSecondarySentence(lang: Lang, secondaryNouns?: string[]) {
  const nouns = (secondaryNouns || []).filter(Boolean).map((x) => String(x).trim()).filter(Boolean);

  if (lang === "en") {
    if (nouns.length) {
      const label = nouns.join("/");
      return `If you’d like, I can also share other options (${label}).`;
    }
    return "If you’d like, I can also share other options.";
  }

  // es
  if (nouns.length) {
    const label = nouns.join("/");
    return `Si quieres, también puedo mostrarte otras opciones (${label}).`;
  }
  return "Si quieres, también puedo mostrarte otras opciones.";
}

/**
 * Mantiene baseText EXACTO y solo agrega 1 frase natural al final.
 * No reescribe, no cambia listas, no compacta.
 */
export function naturalizeSecondaryOptionsLine(args: Args): string {
  const {
    idiomaDestino,
    baseText,
    secondaryAvailable,
    secondaryNouns,
    avoidIfAlreadyHasCTA = true,
    maxLines = 16,
  } = args;

  const base = normalizeEnd(baseText);
  if (!base) return baseText;

  if (!secondaryAvailable) return base;
  if (avoidIfAlreadyHasCTA && hasCTAOrQuestion(base)) return base;

  const sentence = buildSecondarySentence(idiomaDestino, secondaryNouns);

  // Asegura separación limpia sin romper formato anterior
  return `${base}\n${sentence}`;
}
