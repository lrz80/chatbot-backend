import type { Lang } from "../channels/engine/clients/clientDb";

export type ChoiceOption = { key: string; label: string; payload?: any };

export type ChoicePatch = {
  last_choice_kind: string;
  last_choice_at: number;
  last_choice_options: ChoiceOption[];
};

function cleanLabel(s: string) {
  return String(s || "")
    .replace(/^[\s"“”'’]+|[\s"“”'’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta preguntas de selección BINARIA del asistente:
 * ES: "¿Te interesa A, B o ambas/ambos?"
 * EN: "Are you interested in A, B, or both?"
 *
 * Genérico y multi-tenant (no depende del negocio).
 */
export function extractBinaryChoicePatch(args: {
  assistantText: string;
  lang: Lang;
  kind?: string; // opcional: "interest", "service", etc.
}): ChoicePatch | null {
  const { assistantText, lang, kind = "llm_binary_choice" } = args;
  const t = String(assistantText || "").trim();
  if (!t) return null;

  // ES
  const es = t.match(
    /(?:¿\s*)?te\s+interesa\s+(.+?)\s*,\s*(.+?)\s+o\s+(?:ambas|ambos)\s*\?/i
  );

  // EN
  const en = t.match(
    /are\s+you\s+interested\s+in\s+(.+?)\s*,\s*(.+?)\s+or\s+both\s*\?/i
  );

  let a: string | null = null;
  let b: string | null = null;

  if (es) {
    a = cleanLabel(es[1]);
    b = cleanLabel(es[2]);
  } else if (en) {
    a = cleanLabel(en[1]);
    b = cleanLabel(en[2]);
  }

  if (!a || !b) return null;

  // Evita capturar cosas absurdas (demasiado largas)
  if (a.length > 60 || b.length > 60) return null;

  return {
    last_choice_kind: kind,
    last_choice_at: Date.now(),
    last_choice_options: [
      { key: "A", label: a },
      { key: "B", label: b },
      { key: "ALL", label: lang === "en" ? "Both" : "Ambas" }, // ✅ sin detector infinito
    ],
  };
}
