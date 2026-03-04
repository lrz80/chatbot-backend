import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

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
      // configurable por tenant
      reply: string;
      minutes: number;
    };

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
  // cancelación / crédito
  "cancelé",
  "cancele",
  "cancelación",
  "cancelacion",
  "crédito",
  "credito",
];

function norm(s: any) {
  return String(s || "").trim().toLowerCase();
}

export function supportGate(input: SupportGateInput): SupportGateResult {
  const text = norm(input.userInput);
  const intent = norm(input.detectedIntent);
  const emotion = norm(input.emotion);

  // ===== tenant-config (multi-tenant) =====
  const settings = input.tenant?.settings || {};
  const enabled = settings?.support_handoff_enabled !== false; // default true
  if (!enabled) return { escalate: false };

  const minutes =
    Number.isFinite(Number(settings?.support_handoff_minutes)) &&
    Number(settings?.support_handoff_minutes) > 0
      ? Number(settings.support_handoff_minutes)
      : 15;

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

  const keywords = [...DEFAULT_SUPPORT_KEYWORDS, ...customKeywords.map(norm)].filter(Boolean);

  // ===== generic decision =====
  const matchEmotion = NEG_EMOTIONS.has(emotion);
  const matchIntent = intent && intents.has(intent);
  const matchKeyword = keywords.some((k) => k && text.includes(k));

  if (!(matchEmotion || matchIntent || matchKeyword)) return { escalate: false };

  const reply =
    input.idiomaDestino === "en"
      ? "I understand—this looks like a support issue. I’m routing your message to our team so they can help you directly."
      : "Entiendo—esto parece un tema de soporte. Voy a enviar tu mensaje al equipo para que te ayuden directamente.";

  return {
    escalate: true,
    reason: matchIntent ? `intent:${intent}` : matchEmotion ? `emotion:${emotion}` : "keyword",
    reply,
    minutes,
  };
}