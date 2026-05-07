// src/lib/voice/resolveVoiceIntentFromUtterance.ts

import OpenAI from "openai";

export type VoiceIntent =
  | "booking"
  | "prices"
  | "hours"
  | "location"
  | "human_handoff"
  | "unknown";

type VoiceIntentResult = {
  intent: VoiceIntent;
  confidence: number;
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const CACHE_VERSION = "v1_voice_intent_classifier";
const CACHE_MAX_ITEMS = 500;
const DEFAULT_TIMEOUT_MS = 2500;

const cache = new Map<string, VoiceIntentResult>();
const pending = new Map<string, Promise<VoiceIntentResult>>();

function normalizeUtterance(input: string): string {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fallbackResult(): VoiceIntentResult {
  return {
    intent: "unknown",
    confidence: 0,
  };
}

function setCache(key: string, value: VoiceIntentResult) {
  if (cache.size >= CACHE_MAX_ITEMS) {
    const firstKey = cache.keys().next().value;

    if (firstKey) {
      cache.delete(firstKey);
    }
  }

  cache.set(key, value);
}

function parseIntentResult(raw: string): VoiceIntentResult {
  try {
    const parsed = JSON.parse(String(raw || "").trim());

    const intent: VoiceIntent =
      parsed?.intent === "booking" ||
      parsed?.intent === "prices" ||
      parsed?.intent === "hours" ||
      parsed?.intent === "location" ||
      parsed?.intent === "human_handoff" ||
      parsed?.intent === "unknown"
        ? parsed.intent
        : "unknown";

    const confidence =
      typeof parsed?.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

    return {
      intent,
      confidence,
    };
  } catch {
    return fallbackResult();
  }
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

function buildClassifierPrompt(utterance: string): string {
  return `
Classify the user's short phone utterance into exactly one routing intent.

Allowed intents:
- booking: the user wants to create, schedule, reserve, book, or ask how to make an appointment/reservation.
- prices: the user is asking about cost, pricing, rates, fees, or how much something is.
- hours: the user is asking about business hours, availability hours, open/closed times, or schedule information.
- location: the user is asking where the business is, address, directions, or location.
- human_handoff: the user wants a representative, person, agent, staff member, or human help.
- unknown: none of the above.

Rules:
- Return only valid JSON.
- Do not answer the user.
- Do not infer business-specific facts.
- Classify based only on the user's utterance.
- Voice transcription may contain small recognition errors.
- If the user asks how to book or how to reserve, classify as booking.
- Confidence must be between 0 and 1.

JSON shape:
{"intent":"booking|prices|hours|location|human_handoff|unknown","confidence":0}

User utterance:
${utterance}
`.trim();
}

async function classifyWithOpenAI(utterance: string): Promise<VoiceIntentResult> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackResult();
  }

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict voice routing classifier. Return only JSON.",
      },
      {
        role: "user",
        content: buildClassifierPrompt(utterance),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || "";
  return parseIntentResult(raw);
}

export async function resolveVoiceIntentFromUtteranceAsync(
  input: string,
  options: {
    timeoutMs?: number;
    minConfidence?: number;
  } = {}
): Promise<VoiceIntent> {
  const utterance = normalizeUtterance(input);

  if (!utterance) {
    return "unknown";
  }

  const cacheKey = `${CACHE_VERSION}::${utterance}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.confidence >= (options.minConfidence ?? 0.65)
      ? cached.intent
      : "unknown";
  }

  const existing = pending.get(cacheKey);

  if (existing) {
    const result = await withTimeout(
      existing,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fallbackResult()
    );

    return result.confidence >= (options.minConfidence ?? 0.65)
      ? result.intent
      : "unknown";
  }

  const task = classifyWithOpenAI(utterance)
    .then((result) => {
      setCache(cacheKey, result);
      return result;
    })
    .catch((error) => {
      console.warn("[VOICE][INTENT_CLASSIFIER][FALLBACK]", {
        utterance,
        error: error?.message || error,
      });

      return fallbackResult();
    })
    .finally(() => {
      pending.delete(cacheKey);
    });

  pending.set(cacheKey, task);

  const result = await withTimeout(
    task,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fallbackResult()
  );

  return result.confidence >= (options.minConfidence ?? 0.65)
    ? result.intent
    : "unknown";
}

/**
 * Mantener esta función sync evita romper imports existentes.
 * Pero no debe usarse para decisiones nuevas de voz que necesitan robustez.
 */
export function resolveVoiceIntentFromUtterance(_input: string): VoiceIntent {
  return "unknown";
}