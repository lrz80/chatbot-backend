// src/lib/voice/resolveVoiceMetaSignal.ts

import OpenAI from "openai";

export type VoiceMetaSignal = {
  intent: "affirm" | "reject" | "close" | "none";
  confidence: number;
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const CACHE_VERSION = "v2_voice_meta_signal";
const CACHE_MAX_ITEMS = 500;
const DEFAULT_TIMEOUT_MS = 1200;

const cache = new Map<string, VoiceMetaSignal>();
const pending = new Map<string, Promise<VoiceMetaSignal>>();

function normalizeLocale(locale?: string | null): string {
  const raw = String(locale || "").trim().toLowerCase();

  if (!raw) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("pt")) return "pt";

  return "en";
}

function normalizeUtterance(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getCacheKey(locale: string, utterance: string): string {
  return `${CACHE_VERSION}::${locale}::${utterance}`;
}

function setCache(key: string, value: VoiceMetaSignal) {
  if (cache.size >= CACHE_MAX_ITEMS) {
    const firstKey = cache.keys().next().value;

    if (firstKey) {
      cache.delete(firstKey);
    }
  }

  cache.set(key, value);
}

function fallbackSignal(): VoiceMetaSignal {
  return { intent: "none", confidence: 0 };
}

function parseVoiceMetaSignal(raw: string): VoiceMetaSignal {
  try {
    const obj = JSON.parse(String(raw || "").trim());

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

    return { intent, confidence };
  } catch {
    return fallbackSignal();
  }
}

function buildPrompt(params: {
  utterance: string;
  locale: string;
}): string {
  const localeInstruction =
    params.locale === "es"
      ? "The user is speaking Spanish."
      : params.locale === "pt"
      ? "The user is speaking Portuguese."
      : "The user is speaking English.";

  return `
You are classifying a short voice utterance from a phone call.

${localeInstruction}

Return ONLY strict JSON with this exact shape:
{"intent":"affirm"|"reject"|"close"|"none","confidence":0}

Rules:
- "affirm" means the user is confirming or agreeing.
- "reject" means the user is declining, refusing, or saying not now.
- "close" means the user is ending the conversation or saying they are done.
- "none" means none of the above.
- Prefer "close" over "affirm" when the user is clearly ending the conversation.
- A simple "thank you" alone is usually "none", not "close".
- "okay" alone is usually "none", unless the utterance clearly ends the conversation.
- Confidence must be a number between 0 and 1.

Utterance:
${params.utterance}
`.trim();
}

async function resolveWithOpenAI(params: {
  utterance: string;
  locale: string;
}): Promise<VoiceMetaSignal> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackSignal();
  }

  const prompt = buildPrompt(params);

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Classify the user's short phone utterance. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content || "";
  return parseVoiceMetaSignal(raw);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function resolveVoiceMetaSignal(params: {
  utterance: string;
  locale?: string | null;
  timeoutMs?: number;
}): Promise<VoiceMetaSignal> {
  const utterance = normalizeUtterance(params.utterance);
  const locale = normalizeLocale(params.locale);

  if (!utterance) {
    return fallbackSignal();
  }

  const cacheKey = getCacheKey(locale, utterance);

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existingPending = pending.get(cacheKey);
  if (existingPending) {
    return withTimeout(
      existingPending,
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fallbackSignal()
    );
  }

  const task = resolveWithOpenAI({
    utterance,
    locale,
  })
    .then((result) => {
      setCache(cacheKey, result);
      return result;
    })
    .catch((error) => {
      console.warn("[VOICE][META_SIGNAL][FALLBACK]", {
        locale,
        utterance,
        error: error?.message || error,
      });

      return fallbackSignal();
    })
    .finally(() => {
      pending.delete(cacheKey);
    });

  pending.set(cacheKey, task);

  return withTimeout(
    task,
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fallbackSignal()
  );
}