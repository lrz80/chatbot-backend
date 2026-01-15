// backend/src/lib/pipeline/steps/intents.ts

import type { Canal } from "../../detectarIntencion";
import { detectarIntencion } from "../../detectarIntencion";

function normalizeIntentAlias(x: string) {
  const s = String(x || "").trim().toLowerCase();
  if (!s) return "";
  // alias comunes / compatibilidad
  const map: Record<string, string> = {
    reservar: "agendar",
    reserva: "agendar",
    agenda: "agendar",
    appointment: "agendar",
    book: "agendar",
    ubicacion: "ubicacion",
    ubicación: "ubicacion",
    direccion: "ubicacion",
    dirección: "ubicacion",
    price: "precio",
    cost: "precio",
    payment: "pago",
    pagar: "pago",
  };
  return map[s] || s;
}

function isDirectIntent(intent: string) {
  const s = String(intent || "").toLowerCase();
  // “direct” = típicamente intenciones que activan una respuesta exacta/flujo
  // Ajusta si quieres, pero esto es general y seguro.
  return ["pago", "agendar", "precio", "ubicacion", "horario", "cancelar"].includes(s);
}

// Si ya tienes estos helpers en otro lado, puedes importarlos y borrar los locales.
function normText(t: string) {
  return String(t || "").trim();
}

function isGreetingOnly(t: string) {
  const x = normText(t).toLowerCase();
  return /^(hola|hello|hi|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey)\b[\s!.]*$/i.test(
    x
  );
}

function isThanksOnly(t: string) {
  const x = normText(t).toLowerCase();
  return /^(gracias|thank(s| you)|ty)\b[\s!.]*$/i.test(x);
}

export type CanonicalIntentResult = {
  intent: string | null;
  nivel: number;
};

/**
 * ReplyDecision es "decision-only": NO envía, NO guarda, NO llama OpenAI.
 * Solo devuelve una decisión para que el caller decida cómo responder.
 */
export type ReplyDecision =
  | {
      kind: "reply";
      intent: string | null;
      nivel?: number | null;
      replySource: "canonical" | "intent-matcher" | "multi-intent";
      facts?: Record<string, any>;
      directText?: string | null;
      transition?: { flow?: string; step?: string; patchCtx?: any } | null;
    }
  | {
      kind: "pass";
      reason: "no_input" | "greeting_or_thanks_only" | "low_confidence" | "no_match";
      intent?: string | null;
      nivel?: number | null;
    };

export type IntentStepDeps = {
  canal: Canal;
  tenantId: string;
  idiomaDestino: "es" | "en";
  userInput: string;

  intentMin?: number; // default 0.55
  matcherMinOverride?: number; // default 0.85

  intentMatcher?: (args: {
    tenantId: string;
    canal: Canal;
    idiomaDestino: "es" | "en";
    userInput: string;
    intentHint?: string | null;
  }) => Promise<null | { intent: string; score: number; answer?: string | null }>;

  multiIntent?: (args: {
    tenantId: string;
    canal: Canal;
    idiomaDestino: "es" | "en";
    userInput: string;
  }) => Promise<null | { intents: Array<{ intent: string; score?: number }>; answer?: string | null }>;

  directIntents?: Set<string>;
};

/**
 * 1) detectCanonicalIntent(...)
 * - Usa detectarIntencion(text, tenantId, canal)
 * - Normaliza aliases
 */
export async function detectCanonicalIntent(
  deps: Pick<IntentStepDeps, "tenantId" | "canal" | "userInput">
): Promise<CanonicalIntentResult> {
  const text = normText(deps.userInput);
  if (!text) return { intent: null, nivel: 0 };

  // 👇 IMPORTANTE: ahora se pasa tenantId y canal
  const r = await detectarIntencion(text, deps.tenantId, deps.canal);

  // 👇 IMPORTANTE: tu detectarIntencion devuelve { intencion, nivel_interes }
  const rawIntent = String((r as any)?.intencion || "").trim();
  const nivel = Number((r as any)?.nivel_interes ?? 0) || 0;

  if (!rawIntent) return { intent: null, nivel };

  const canon = normalizeIntentAlias(rawIntent);
  const intent = canon ? String(canon) : rawIntent;

  return { intent, nivel };
}

/**
 * 2) tryIntentMatcher(...)
 */
export async function tryIntentMatcher(
  deps: IntentStepDeps,
  canon: CanonicalIntentResult
): Promise<ReplyDecision | null> {
  const {
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    intentMatcher,
    intentMin = 0.55,
    matcherMinOverride = 0.85,
    directIntents,
  } = deps;

  if (!intentMatcher) return null;

  const text = normText(userInput);
  if (!text) return { kind: "pass", reason: "no_input", intent: null, nivel: 0 };

  if (isGreetingOnly(text) || isThanksOnly(text)) {
    return { kind: "pass", reason: "greeting_or_thanks_only", intent: null, nivel: 0 };
  }

  const intentHint = canon.intent || null;
  const nivel = canon.nivel ?? 0;

  const canonIsDirect =
    (directIntents && intentHint ? directIntents.has(intentHint) : false) ||
    (intentHint ? isDirectIntent(intentHint) : false);

  const match = await intentMatcher({
    tenantId,
    canal,
    idiomaDestino,
    userInput: text,
    intentHint,
  });

  if (!match) return { kind: "pass", reason: "no_match", intent: intentHint, nivel };

  const score = Number(match.score ?? 0) || 0;
  const matchedIntent = normalizeIntentAlias(match.intent) || match.intent;

  if (score < intentMin) {
    return { kind: "pass", reason: "low_confidence", intent: intentHint, nivel };
  }

  if (canonIsDirect && score < matcherMinOverride) {
    return { kind: "pass", reason: "low_confidence", intent: intentHint, nivel };
  }

  return {
    kind: "reply",
    replySource: "intent-matcher",
    intent: matchedIntent || intentHint || null,
    nivel: score,
    directText: match.answer ?? null,
    facts: {
      EVENT: "INTENT_MATCHER_HIT",
      INTENT: matchedIntent || null,
      SCORE: score,
      LANGUAGE: idiomaDestino,
    },
  };
}

/**
 * 3) tryMultiIntentFastPath(...)
 */
export async function tryMultiIntentFastPath(
  deps: IntentStepDeps
): Promise<ReplyDecision | null> {
  const { multiIntent, tenantId, canal, idiomaDestino, userInput } = deps;
  if (!multiIntent) return null;

  const text = normText(userInput);
  if (!text) return { kind: "pass", reason: "no_input", intent: null, nivel: 0 };

  if (isGreetingOnly(text) || isThanksOnly(text)) {
    return { kind: "pass", reason: "greeting_or_thanks_only", intent: null, nivel: 0 };
  }

  const mi = await multiIntent({ tenantId, canal, idiomaDestino, userInput: text });
  if (!mi) return null;

  const intents = Array.isArray(mi.intents) ? mi.intents : [];
  if (intents.length < 2) return null;

  const uniq = new Set(intents.map((x) => normalizeIntentAlias(x.intent) || x.intent));
  if (uniq.size < 2) return null;

  return {
    kind: "reply",
    replySource: "multi-intent",
    intent: null,
    directText: mi.answer ?? null,
    facts: {
      EVENT: "MULTI_INTENT_FASTPATH",
      LANGUAGE: idiomaDestino,
      INTENTS: intents.map((x) => ({
        intent: normalizeIntentAlias(x.intent) || x.intent,
        score: x.score ?? null,
      })),
    },
  };
}
