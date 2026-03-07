// backend/src/lib/fastpath/extractQueryFrames.ts

export type AskedAttribute =
  | "price"
  | "includes"
  | "schedule"
  | "availability"
  | "unknown";

export type QueryFrame = {
  raw: string;
  askedAttribute: AskedAttribute;
  referencedEntityText: string | null;
  modifiers: string[];
};

function normalize(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitUserQuestions(raw: string): string[] {
  return String(raw || "")
    .split(/\n+|[?]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.length >= 3);
}

function detectAskedAttribute(raw: string): AskedAttribute {
  const t = normalize(raw);

  if (!t) return "unknown";

  if (
    /\b(precio|precios|cuanto cuesta|cuanto vale|cuanto seria|cuanto sale|costo|cost|price|pricing|how much|from|desde)\b/i.test(
      t
    )
  ) {
    return "price";
  }

  if (
    /\b(que incluye|que trae|incluye|incluyen|detalle|detalles|what is included|what does .* include|more detail|more details|tell me more about)\b/i.test(
      t
    )
  ) {
    return "includes";
  }

  if (
    /\b(horario|horarios|hora|horas|schedule|schedules|hours)\b/i.test(t)
  ) {
    return "schedule";
  }

  if (
    /\b(disponible|disponibilidad|available|availability|hay cupo|hay espacio|in stock|stock)\b/i.test(
      t
    )
  ) {
    return "availability";
  }

  return "unknown";
}

function extractReferencedEntityText(raw: string): string | null {
  const t = normalize(raw);
  if (!t) return null;

  let cleaned = t;

  cleaned = cleaned
    .replace(
      /\b(precio|precios|cuanto cuesta|cuanto vale|cuanto seria|cuanto sale|costo|cost|price|pricing|how much|from|desde)\b/gi,
      " "
    )
    .replace(
      /\b(que incluye|que trae|incluye|incluyen|detalle|detalles|what is included|what does|include|more detail|more details|tell me more about)\b/gi,
      " "
    )
    .replace(/\b(horario|horarios|hora|horas|schedule|schedules|hours)\b/gi, " ")
    .replace(/\b(disponible|disponibilidad|available|availability|stock)\b/gi, " ")
    .replace(/\b(y|and|el|la|los|las|the|a|an|de|del|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;

  return cleaned;
}

function extractModifiers(raw: string, referencedEntityText: string | null): string[] {
  const t = normalize(raw);
  if (!t) return [];

  const ref = normalize(referencedEntityText || "");
  let source = t;

  if (ref) {
    source = source.replace(ref, " ");
  }

  const tokens = source
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter(
      (x) =>
        ![
          "que",
          "q",
          "y",
          "and",
          "el",
          "la",
          "los",
          "las",
          "the",
          "a",
          "an",
          "de",
          "del",
          "what",
          "does",
          "include",
          "incluye",
          "incluyen",
          "precio",
          "precios",
          "price",
          "pricing",
          "schedule",
          "hours",
          "horario",
          "horarios",
        ].includes(x)
    );

  return Array.from(new Set(tokens)).slice(0, 8);
}

export function extractQueryFrames(userInput: string): QueryFrame[] {
  const parts = splitUserQuestions(userInput);

  return parts.map((raw) => {
    const askedAttribute = detectAskedAttribute(raw);
    const referencedEntityText = extractReferencedEntityText(raw);
    const modifiers = extractModifiers(raw, referencedEntityText);

    return {
      raw,
      askedAttribute,
      referencedEntityText,
      modifiers,
    };
  });
}