// src/lib/voice/resolveVoiceMetaSignal.ts

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const cache = new Map<string, VoiceMetaSignal>();
const CACHE_VERSION = "v1_voice_meta_signal";

export type VoiceMetaSignal = {
  intent: "affirm" | "reject" | "close" | "none";
  confidence: number;
};

function normalizeLocale(locale?: string | null): string {
  const raw = String(locale || "").trim().toLowerCase();

  if (!raw) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("pt")) return "pt";

  return "en";
}

function normalizeUtterance(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export async function resolveVoiceMetaSignal(params: {
  utterance: string;
  locale?: string | null;
}): Promise<VoiceMetaSignal> {
  const utterance = normalizeUtterance(params.utterance);
  const locale = normalizeLocale(params.locale);

  if (!utterance) {
    return { intent: "none", confidence: 0 };
  }

  const cacheKey = `${CACHE_VERSION}::${locale}::${utterance}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const localeInstruction =
    locale === "es"
      ? "The user is speaking Spanish."
      : locale === "pt"
      ? "The user is speaking Portuguese."
      : "The user is speaking English.";

  const prompt = `
You are classifying a short voice utterance from a phone call.

${localeInstruction}

Return ONLY strict JSON with this exact shape:
{"intent":"affirm"|"reject"|"close"|"none","confidence":0}

Rules:
- "affirm" means the user is confirming or agreeing.
- "reject" means the user is declining, refusing, or saying not now.
- "close" means the user is ending the conversation or saying they are done.
- "none" means none of the above.
- Prefer "close" over "affirm" when the user says things like "that's it", "that's all", "bye", "hasta luego", etc.
- A simple "thank you" alone is usually "none", not "close".
- "okay" alone is usually "none", unless the utterance clearly ends the conversation.
- Confidence must be a number between 0 and 1.

Utterance:
${utterance}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let parsed: VoiceMetaSignal = { intent: "none", confidence: 0 };

  try {
    const raw = response.output_text.trim();
    const obj = JSON.parse(raw);

    const intent =
      obj?.intent === "affirm" ||
      obj?.intent === "reject" ||
      obj?.intent === "close" ||
      obj?.intent === "none"
        ? obj.intent
        : "none";

    const confidence =
      typeof obj?.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0;

    parsed = { intent, confidence };
  } catch {
    parsed = { intent: "none", confidence: 0 };
  }

  cache.set(cacheKey, parsed);
  return parsed;
}