import type { Canal } from "../detectarIntencion";

type Emotion =
  | "enfado"
  | "frustracion"
  | "neutral"
  | "interes"
  | "entusiasmo"
  | string;

type PurchaseIntentLevel = "unknown" | "low" | "medium" | "high";
type CommercialUrgencyLevel = "unknown" | "low" | "medium" | "high";

type CommercialSignal = {
  purchaseIntent: PurchaseIntentLevel;
  wantsBooking: boolean;
  wantsQuote: boolean;
  wantsHuman: boolean;
  urgency: CommercialUrgencyLevel;
};

function normalizeLevel(value: unknown): PurchaseIntentLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeUrgency(value: unknown): CommercialUrgencyLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeCommercialSignal(
  value?: Partial<CommercialSignal> | null
): CommercialSignal {
  return {
    purchaseIntent: normalizeLevel(value?.purchaseIntent),
    wantsBooking: value?.wantsBooking === true,
    wantsQuote: value?.wantsQuote === true,
    wantsHuman: value?.wantsHuman === true,
    urgency: normalizeUrgency(value?.urgency),
  };
}

function shouldCloseFromEmotion(input: {
  intent: string | null;
  interestLevel: number | null;
  commercial: CommercialSignal;
}): boolean {
  const { intent, interestLevel, commercial } = input;

  const normalizedIntent = String(intent || "").trim().toLowerCase();
  const lvl = typeof interestLevel === "number" ? interestLevel : null;

  if (commercial.purchaseIntent === "high") return true;
  if (commercial.wantsBooking) return true;
  if (commercial.wantsQuote && lvl !== null && lvl >= 2) return true;
  if (commercial.urgency === "high") return true;

  return Boolean(normalizedIntent) && lvl === 3;
}

/**
 * ✅ Human override NO debe activarse por emoción.
 * La emoción solo puede gatillar "clarify" o "close".
 * El handoff_human queda reservado para una petición explícita del usuario
 * (eso se decide en otra capa: gate/shouldHumanOverride).
 */
export async function applyEmotionTriggers(opts: {
  tenantId: string;
  canal: Canal;
  contacto: string;
  emotion: Emotion | null;
  intent: string | null;
  interestLevel: number | null;
  commercial?: Partial<CommercialSignal> | null;

  userMessage?: string | null;
  messageId?: string | null;
}) {
  const { emotion, intent, interestLevel, commercial } = opts;

  const e = String(emotion || "").trim().toLowerCase();
  const commercialSignal = normalizeCommercialSignal(commercial);

  let action: "none" | "handoff_human" | "clarify" | "close" = "none";
  let replyOverride: string | null = null;
  let ctxPatch: any = {};

  if (e === "enfado" || e === "frustracion") {
    action = "clarify";
    ctxPatch = { needs_clarify: true, last_emotion: e };
  }

  if (
    action === "none" &&
    e === "entusiasmo" &&
    shouldCloseFromEmotion({
      intent,
      interestLevel,
      commercial: commercialSignal,
    })
  ) {
    action = "close";
    ctxPatch = {
      ready_to_close: true,
      last_emotion: e,
      commercialSignal: {
        purchaseIntent: commercialSignal.purchaseIntent,
        wantsBooking: commercialSignal.wantsBooking,
        wantsQuote: commercialSignal.wantsQuote,
        wantsHuman: commercialSignal.wantsHuman,
        urgency: commercialSignal.urgency,
      },
    };
  }

  return { action, replyOverride, ctxPatch };
}