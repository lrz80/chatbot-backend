import OpenAI from "openai";

export type LangCode = string;

export type DetectIdiomaSource = "openai" | "none";

export type DetectIdiomaResult = {
  lang: LangCode | null;
  confidence: number;
  source: DetectIdiomaSource;
};

function normalizeLangCode(value: unknown): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;

  const normalized = raw.replace("_", "-").split("-")[0]?.trim();
  if (!normalized) return null;

  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    console.warn("[detectarIdioma] OPENAI_API_KEY no está configurada en el backend runtime");
    return null;
  }

  return new OpenAI({ apiKey });
}

function safeParseDetection(content: string): DetectIdiomaResult {
  try {
    const parsed = JSON.parse(content) as {
      lang?: unknown;
      confidence?: unknown;
    };

    const lang = normalizeLangCode(parsed.lang);
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
  } catch (error) {
    console.warn("[detectarIdioma] JSON inválido recibido desde OpenAI", {
      error: error instanceof Error ? error.message : String(error),
      content,
    });

    return { lang: null, confidence: 0, source: "none" };
  }
}

export async function detectarIdioma(texto: string): Promise<DetectIdiomaResult> {
  const raw = String(texto || "").trim();

  if (!raw) {
    return { lang: null, confidence: 0, source: "none" };
  }

  const openai = getOpenAIClient();
  if (!openai) {
    return { lang: null, confidence: 0, source: "none" };
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "Detect the primary language of the user's message.",
            "Return valid JSON only.",
            'Use this exact schema: {"lang":"xx","confidence":0.0}.',
            "lang must be a lowercase ISO 639-1 code when possible, such as en, es, pt, fr, it, de.",
            "confidence must be a number between 0 and 1.",
            "If the language cannot be determined reliably, return {\"lang\":null,\"confidence\":0}."
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
      console.warn("[detectarIdioma] OpenAI respondió sin content", {
        input: raw,
      });
      return { lang: null, confidence: 0, source: "none" };
    }

    return safeParseDetection(content);
  } catch (error) {
    console.warn("[detectarIdioma] Error llamando OpenAI", {
      input: raw,
      error: error instanceof Error ? error.message : String(error),
    });

    return { lang: null, confidence: 0, source: "none" };
  }
}