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

const CACHE_VERSION = "v2_voice_intent_classifier";
const CACHE_MAX_ITEMS = 500;
const DEFAULT_TIMEOUT_MS = 2500;

const cache = new Map<string, VoiceIntentResult>();
const pending = new Map<string, Promise<VoiceIntentResult>>();

function normalizeUtterance(input: string): string {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(input: string): string[] {
  return normalizeUtterance(input)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
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
- booking: the user wants to create, schedule, reserve, book, make, set up, or ask how to make an appointment/reservation.
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
- If the user asks how to book, how to reserve, how to make an appointment, or how to schedule an appointment, classify as booking.
- Confidence must be between 0 and 1.

JSON shape:
{"intent":"booking|prices|hours|location|human_handoff|unknown","confidence":0}

User utterance:
${utterance}
`.trim();
}

function hasAnyToken(tokens: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

function includesAnyPhrase(utterance: string, phrases: string[]): boolean {
  return phrases.some((phrase) => utterance.includes(phrase));
}

function resolveFastIntent(utterance: string): VoiceIntentResult | null {
  const normalized = normalizeUtterance(utterance);

  if (!normalized) {
    return null;
  }

  const tokens = new Set(tokenize(normalized));

  const bookingVerbTokens = [
    "reservar",
    "reserva",
    "agendar",
    "agenda",
    "cita",
    "book",
    "booking",
    "schedule",
    "scheduled",
    "appointment",
    "appoint",
  ];

  const bookingPhrases = [
    "hacer una cita",
    "quiero hacer una cita",
    "quiero una cita",
    "agendar una cita",
    "reservar una cita",
    "sacar una cita",
    "hacer cita",
    "book an appointment",
    "make an appointment",
    "schedule an appointment",
    "book appointment",
    "set up an appointment",
    "how to book",
    "how to make an appointment",
    "how to schedule",
    "como reservar",
    "como hacer una cita",
    "como agendar",
  ];

  const pricesTokens = [
    "precio",
    "precios",
    "coste",
    "costo",
    "cuanto",
    "vale",
    "tarifa",
    "tarifas",
    "rates",
    "rate",
    "price",
    "prices",
    "cost",
    "fee",
    "fees",
  ];

  const pricesPhrases = [
    "how much",
    "how much is",
    "how much does it cost",
    "cuanto cuesta",
    "cuanto vale",
    "que precio",
    "que precios",
  ];

  const hoursTokens = [
    "horario",
    "horarios",
    "hora",
    "horas",
    "abren",
    "abierto",
    "cierran",
    "cerrado",
    "open",
    "opened",
    "opening",
    "close",
    "closed",
    "hours",
    "schedule",
  ];

  const hoursPhrases = [
    "a que hora abren",
    "a que hora cierran",
    "what time do you open",
    "what time do you close",
    "business hours",
    "store hours",
    "opening hours",
  ];

  const locationTokens = [
    "direccion",
    "ubicacion",
    "donde",
    "queda",
    "address",
    "location",
    "located",
    "directions",
    "where",
  ];

  const locationPhrases = [
    "donde estan",
    "donde se encuentran",
    "cual es la direccion",
    "where are you",
    "where are you located",
    "what is the address",
    "send me the address",
  ];

  const humanTokens = [
    "representative",
    "representante",
    "human",
    "humano",
    "agent",
    "agente",
    "person",
    "persona",
    "staff",
    "manager",
  ];

  const humanPhrases = [
    "speak to a person",
    "talk to a person",
    "talk to someone",
    "speak to someone",
    "quiero hablar con alguien",
    "quiero hablar con una persona",
    "quiero hablar con un representante",
    "pasame con alguien",
    "pasame con un representante",
  ];

  if (
    includesAnyPhrase(normalized, bookingPhrases) ||
    (
      hasAnyToken(tokens, bookingVerbTokens) &&
      (
        tokens.has("cita") ||
        tokens.has("appointment") ||
        tokens.has("reservacion") ||
        tokens.has("reservation")
      )
    ) ||
    (
      (tokens.has("hacer") || tokens.has("agendar") || tokens.has("reservar")) &&
      tokens.has("cita")
    )
  ) {
    return {
      intent: "booking",
      confidence: 0.97,
    };
  }

  if (
    includesAnyPhrase(normalized, pricesPhrases) ||
    hasAnyToken(tokens, pricesTokens)
  ) {
    return {
      intent: "prices",
      confidence: 0.95,
    };
  }

  if (
    includesAnyPhrase(normalized, hoursPhrases) ||
    hasAnyToken(tokens, hoursTokens)
  ) {
    return {
      intent: "hours",
      confidence: 0.95,
    };
  }

  if (
    includesAnyPhrase(normalized, locationPhrases) ||
    hasAnyToken(tokens, locationTokens)
  ) {
    return {
      intent: "location",
      confidence: 0.95,
    };
  }

  if (
    includesAnyPhrase(normalized, humanPhrases) ||
    hasAnyToken(tokens, humanTokens)
  ) {
    return {
      intent: "human_handoff",
      confidence: 0.96,
    };
  }

  return null;
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

  const fastIntent = resolveFastIntent(utterance);
  if (fastIntent) {
    return fastIntent.confidence >= (options.minConfidence ?? 0.65)
      ? fastIntent.intent
      : "unknown";
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
export function resolveVoiceIntentFromUtterance(input: string): VoiceIntent {
  const fastIntent = resolveFastIntent(input);

  if (!fastIntent) {
    return "unknown";
  }

  return fastIntent.intent;
}