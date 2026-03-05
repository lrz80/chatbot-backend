// backend/src/lib/guards/supportGate.ts

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { isExplicitHumanRequest } from "../security/humanOverrideGate";

type SupportGateInput = {
  canal: Canal;
  idiomaDestino: Lang;
  userInput: string;
  detectedIntent?: string | null;
  emotion?: string | null;
  tenant: any; // para leer settings
};

type SupportGateResult =
  | { escalate: false }
  | {
      escalate: true;
      reason: string;
      // ✅ reply siempre con link/canal de soporte (multi-tenant)
      reply: string;
      // ✅ TTL recomendado para humanOverride / handoff (GLOBAL)
      minutes: number;
      // ✅ si el caller debe activar humanOverride (pero con TTL)
      setHumanOverride: boolean;
      // ✅ opcional: el link detectado (útil para logs/telemetría)
      supportLink?: string;
    };

// ✅ TTL GLOBAL (no configurable por tenant)
const HUMAN_OVERRIDE_TTL_MINUTES = 10;

const NEG_EMOTIONS = new Set(["frustration", "anger", "enojo", "ira"]);

const DEFAULT_SUPPORT_INTENTS = new Set([
  "soporte",
  "support",
  "queja",
  "complaint",
  "reembolso",
  "refund",
  "problema",
  "problema_sistema",
  "fallo_sistema",
  "cobro",
  "charge",
]);

// ⚠️ OJO: removimos cancelación/crédito de keywords de soporte por defecto
// porque eso suele ser booking normal, no “soporte humano”.
const DEFAULT_SUPPORT_KEYWORDS = [
  // sistema / app
  "no me deja",
  "no funciona",
  "error",
  "problema",
  "no puedo",
  "no sirve",
  "app",
  "sistema",
  // dinero / cobros
  "me cobraron",
  "perdí el dinero",
  "perdi el dinero",
  "reembolso",
  "refund",
  "cobro",
  "charge",
];

// Palabras que suelen ser booking normal.
// Si aparecen “solas” no deben disparar soporte/handoff.
const BOOKING_ONLY_WORDS = [
  "cancelé",
  "cancele",
  "cancelación",
  "cancelacion",
  "crédito",
  "credito",
];

// Si aparecen junto a estas, sí puede ser soporte real.
const SUPPORT_CONTEXT_WORDS = [
  "error",
  "no funciona",
  "no me deja",
  "no puedo",
  "cobro",
  "me cobraron",
  "reembolso",
  "refund",
  "problema",
  "fallo",
];

function norm(s: any) {
  return String(s || "").trim().toLowerCase();
}

function getSupportLink(tenant: any): string | null {
  const settings = tenant?.settings || {};
  const link =
    settings.support_link ||
    settings.support_url ||
    settings.support_contact_url ||
    settings.support_whatsapp_link ||
    settings.support_email_link ||
    settings.contact_link ||
    settings.contact_url;

  const v = String(link || "").trim();
  return v ? v : null;
}

function buildSupportReply(lang: Lang, supportLink: string, wantsHuman: boolean) {
  const isEn = lang === "en";
  if (wantsHuman) {
    return isEn
      ? `Got it — I’ll connect you with a human.\n\nPlease contact our support team here:\n${supportLink}`
      : `Listo — te conecto con una persona.\n\nPuedes contactar a nuestro equipo de soporte aquí:\n${supportLink}`;
  }
  return isEn
    ? `For support, please contact our team here:\n${supportLink}`
    : `Para soporte, puedes contactar a nuestro equipo aquí:\n${supportLink}`;
}

export function supportGate(input: SupportGateInput): SupportGateResult {
  const text = norm(input.userInput);
  const intent = norm(input.detectedIntent);
  const emotion = norm(input.emotion);

  // ===== tenant-config (multi-tenant) =====
  const settings = input.tenant?.settings || {};
  const enabled = settings?.support_handoff_enabled !== false; // default true
  if (!enabled) return { escalate: false };

  // ✅ TTL GLOBAL (ya no se lee de settings)
  const minutes = HUMAN_OVERRIDE_TTL_MINUTES;

  const customIntents: string[] = Array.isArray(settings?.support_handoff_intents)
    ? settings.support_handoff_intents
    : [];

  const customKeywords: string[] = Array.isArray(settings?.support_handoff_keywords)
    ? settings.support_handoff_keywords
    : [];

  const intents = new Set([
    ...DEFAULT_SUPPORT_INTENTS,
    ...customIntents.map(norm).filter(Boolean),
  ]);

  // keywords custom del tenant sí pueden incluir “cancelación” si ese tenant quiere,
  // pero protegemos el caso “booking-only” igual.
  const keywords = [...DEFAULT_SUPPORT_KEYWORDS, ...customKeywords.map(norm)].filter(Boolean);

  // ===== señales =====
  const wantsHuman = isExplicitHumanRequest(input.userInput);

  const matchEmotion = NEG_EMOTIONS.has(emotion);
  const matchIntent = intent && intents.has(intent);
  const matchKeyword = keywords.some((k) => k && text.includes(k));

  // ===== evitar falsos positivos de booking =====
  const hasBookingWord = BOOKING_ONLY_WORDS.some((w) => text.includes(w));
  const hasSupportContext = SUPPORT_CONTEXT_WORDS.some((w) => text.includes(w));

  // Si es “cancelé / crédito” sin contexto de soporte y NO pidió humano explícito,
  // no lo tratamos como soporte/handoff.
  if (hasBookingWord && !hasSupportContext && !matchIntent && !wantsHuman) {
    return { escalate: false };
  }

  // ===== decisión final =====
  // Si pidió humano explícitamente, escalamos siempre (pero igual mandamos link)
  // Si no pidió humano, escalamos solo si hay señales de soporte.
  const shouldEscalate = wantsHuman || matchEmotion || matchIntent || matchKeyword;

  if (!shouldEscalate) return { escalate: false };

  const supportLink = getSupportLink(input.tenant);

  // Si no hay link configurado, no inventamos. Deja que el resto del engine responda.
  if (!supportLink) return { escalate: false };

  const reply = buildSupportReply(input.idiomaDestino, supportLink, wantsHuman);

  return {
    escalate: true,
    reason: wantsHuman
      ? "explicit_human_request"
      : matchIntent
      ? `intent:${intent}`
      : matchEmotion
      ? `emotion:${emotion}`
      : "keyword",
    reply,
    minutes,
    // ✅ Solo activa humanOverride si pidió humano explícitamente.
    // Aun si NO lo activa, igual se envía el link (reply).
    setHumanOverride: wantsHuman,
    supportLink,
  };
}