import OpenAI from "openai";

export type LangCode = string;

export type DetectIdiomaSource = "openai" | "none";

export type DetectIdiomaResult = {
  lang: LangCode | null;
  confidence: number;
  source: DetectIdiomaSource;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function normalizeLangCode(value: string): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;

  // Normaliza formatos comunes: pt-BR -> pt, en_US -> en
  const normalized = raw.replace("_", "-").split("-")[0]?.trim();

  if (!normalized) return null;

  // ISO 639-1 simple: dos letras
  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

export async function detectarIdioma(texto: string): Promise<DetectIdiomaResult> {
  const raw = String(texto || "").trim();

  if (!raw) {
    return { lang: null, confidence: 0, source: "none" };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { lang: null, confidence: 0, source: "none" };
  }

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "Detect the primary language of the user text.",
          "Reply with JSON only.",
          'Use this exact schema: {"lang":"xx","confidence":0.0}.',
          "Return lang as a lowercase ISO 639-1 language code when possible, for example: es, en, pt, fr, it, de.",
          "If the language cannot be determined reliably, return lang as null and confidence as 0."
        ].join(" "),
      },
      {
        role: "user",
        content: raw,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = res.choices[0]?.message?.content?.trim();
  if (!content) {
    return { lang: null, confidence: 0, source: "none" };
  }

  try {
    const parsed = JSON.parse(content) as {
      lang?: unknown;
      confidence?: unknown;
    };

    const lang = normalizeLangCode(String(parsed.lang ?? ""));
    const confidenceRaw = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0;

    if (!lang) {
      return { lang: null, confidence: 0, source: "none" };
    }

    return {
      lang,
      confidence,
      source: "openai",
    };
  } catch {
    return { lang: null, confidence: 0, source: "none" };
  }
}