// src/lib/detectTextLanguage.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const cache = new Map<string, string>();
const CACHE_VERSION = "v1_detect_text_language";

export async function detectTextLanguage(texto: string): Promise<string> {
  const input = String(texto || "").trim();
  if (!input) return "unknown";

  const key = `${CACHE_VERSION}::${input}`;
  if (cache.has(key)) return cache.get(key)!;

  const prompt = `
Detect the language of the following text.

Rules:
- Respond with only a lowercase ISO 639-1 language code.
- Examples: es, en, pt, fr, de, it.
- Do not explain.
- Do not add punctuation.

Text:
${input}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const detected = (response.output_text || "").trim().toLowerCase();

  const normalized =
    detected.startsWith("es") ? "es" :
    detected.startsWith("en") ? "en" :
    detected.startsWith("pt") ? "pt" :
    detected.startsWith("fr") ? "fr" :
    detected.startsWith("it") ? "it" :
    detected.startsWith("de") ? "de" :
    "unknown";

  cache.set(key, normalized);
  return normalized;
}