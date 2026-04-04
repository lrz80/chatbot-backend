//src/lib/detectarEmocion.ts
import OpenAI from "openai";
import { EMOCIONES_PERMITIDAS, type Emocion } from "./emotion/categories";
import { normalizeLangCode, type LangCode } from "./i18n/lang";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

type DetectEmotionModelOutput = {
  emotion?: string | null;
};

function normalizeEmotion(value: unknown): Emocion {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return (EMOCIONES_PERMITIDAS as readonly string[]).includes(normalized)
    ? (normalized as Emocion)
    : "neutral";
}

function buildSystemPrompt(lang: LangCode, allowed: readonly string[]): string {
  const categories = allowed.join(", ");

  if (lang === "es") {
    return [
      "Clasifica la emoción principal del mensaje del cliente.",
      "Responde SOLO en JSON válido.",
      'Usa exactamente este formato: {"emotion":"categoria"}.',
      `Las únicas categorías permitidas son: ${categories}.`,
      'Si no estás seguro, responde {"emotion":"neutral"}.',
      "No expliques nada. No agregues texto fuera del JSON.",
    ].join(" ");
  }

  return [
    "Classify the customer's primary emotion.",
    "Reply ONLY with valid JSON.",
    'Use exactly this format: {"emotion":"category"}.',
    `The only allowed categories are: ${categories}.`,
    'If uncertain, return {"emotion":"neutral"}.',
    "Do not explain anything. Do not add text outside the JSON.",
  ].join(" ");
}

export async function detectarEmocion(
  texto: string,
  idioma?: LangCode | null
): Promise<Emocion> {
  const rawText = String(texto || "").trim();
  if (!rawText) return "neutral";

  if (!process.env.OPENAI_API_KEY) {
    return "neutral";
  }

  const normalizedLang = normalizeLangCode(idioma) ?? "en";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(normalizedLang, EMOCIONES_PERMITIDAS),
        },
        {
          role: "user",
          content: rawText,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) return "neutral";

    const parsed = JSON.parse(content) as DetectEmotionModelOutput;
    return normalizeEmotion(parsed.emotion);
  } catch (error: any) {
    console.warn("⚠️ detectarEmocion failed:", error?.message || error);
    return "neutral";
  }
}