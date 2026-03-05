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
  tenant: any;
};

type SupportGateResult =
  | { escalate: false }
  | {
      escalate: true;
      reason: string;
      reply: string;
      minutes: number; // GLOBAL TTL recomendado
      setHumanOverride: boolean;
      supportLink?: string;
    };

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

const DEFAULT_SUPPORT_KEYWORDS = [
  "no me deja",
  "no funciona",
  "error",
  "problema",
  "no puedo",
  "no sirve",
  "app",
  "sistema",
  "me cobraron",
  "perdí el dinero",
  "perdi el dinero",
  "reembolso",
  "refund",
  "cobro",
  "charge",
];

const BOOKING_ONLY_WORDS = [
  "cancelé",
  "cancele",
  "cancelación",
  "cancelacion",
  "crédito",
  "credito",
];

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

  const settings = input.tenant?.settings || {};
  const enabled = settings?.support_handoff_enabled !== false;
  if (!enabled) return { escalate: false };

  const minutes = HUMAN_OVERRIDE_TTL_MINUTES;

  const customIntents: string[] = Array.isArray(settings?.support_handoff_intents)
    ? settings.support_handoff_intents
    : [];

  const customKeywordsRaw: string[] = Array.isArray(settings?.support_handoff_keywords)
    ? settings.support_handoff_keywords
    : [];

  const customKeywords = customKeywordsRaw.map(norm).filter(Boolean);

  const intents = new Set([
    ...DEFAULT_SUPPORT_INTENTS,
    ...customIntents.map(norm).filter(Boolean),
  ]);

  const keywords = [...DEFAULT_SUPPORT_KEYWORDS, ...customKeywords].filter(Boolean);

  const wantsHuman = isExplicitHumanRequest(input.userInput);

  const matchEmotion = NEG_EMOTIONS.has(emotion);
  const matchIntent = intent && intents.has(intent);
  const matchKeyword = keywords.some((k) => k && text.includes(k));

  // ✅ NUEVO: si el match viene de keyword custom del tenant
  const matchCustomKeyword = customKeywords.some((k) => k && text.includes(k));

  // ===== evitar falsos positivos de booking =====
  const hasBookingWord = BOOKING_ONLY_WORDS.some((w) => text.includes(w));
  const hasSupportContext = SUPPORT_CONTEXT_WORDS.some((w) => text.includes(w));

  // ✅ CLAVE: si el tenant optó-in (custom keyword), NO bloquees por booking-only
  if (hasBookingWord && !hasSupportContext && !matchIntent && !wantsHuman && !matchCustomKeyword) {
    return { escalate: false };
  }

  const shouldEscalate = wantsHuman || matchEmotion || matchIntent || matchKeyword;
  if (!shouldEscalate) return { escalate: false };

  const supportLink = getSupportLink(input.tenant);
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
      : matchCustomKeyword
      ? "custom_keyword"
      : "keyword",
    reply,
    minutes,
    setHumanOverride: wantsHuman, // solo si pide humano explícito
    supportLink,
  };
}