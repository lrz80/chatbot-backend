import OpenAI from "openai";

export type LangCode = string;

export type DetectIdiomaSource = "openai" | "none";

export type DetectIdiomaResult = {
  lang: LangCode | null;
  confidence: number;
  source: DetectIdiomaSource;
};

function normalizeLangCode(value: unknown): "es" | "en" | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;

  const normalized = raw.replace(/_/g, "-").split("-")[0]?.trim();
  if (!normalized) return null;

  if (normalized === "es" || normalized === "en") {
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

  return new OpenAI({
    apiKey,
    timeout: 8000,
    maxRetries: 1,
  });
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
            "Detect the dominant language of the user's message for reply purposes.",
            "Return valid JSON only.",
            'Use this exact schema: {"lang":"xx","confidence":0.0}.',
            "Supported output languages are only: es or en.",
            "Confidence must be a number between 0 and 1.",
            "If the message is mixed-language, choose the language that carries the main user intent, not greetings, fillers, or isolated words.",
            "Service names, product names, brands, and borrowed nouns do not define the reply language by themselves.",
            "A short greeting like hi, hello, hola, or buenos does not outweigh the rest of the sentence.",
            "If the language cannot be determined reliably between es and en, return {\"lang\":null,\"confidence\":0}.",
            "Examples:",
            'Input: "Hi, estoy interesada en las clases de cycling" -> {"lang":"es","confidence":0.92}',
            'Input: "Hola, I want pricing" -> {"lang":"en","confidence":0.78}',
            'Input: "hello" -> {"lang":"en","confidence":0.95}',
            'Input: "hola" -> {"lang":"es","confidence":0.95}'
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