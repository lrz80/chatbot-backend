import type { Canal } from "../detectarIntencion";
import { esIntencionDeVenta } from "../detectarIntencion";

type Emotion =
  | "enfado"
  | "frustracion"
  | "neutral"
  | "interes"
  | "entusiasmo"
  | string;

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

  userMessage?: string | null;
  messageId?: string | null;
}) {
  const { emotion, intent, interestLevel } = opts;

  const e = (emotion || "").toString().trim().toLowerCase();
  const i = (intent || "").toString().trim().toLowerCase();
  const lvl = typeof interestLevel === "number" ? interestLevel : null;

  // default: no acción
  let action: "none" | "handoff_human" | "clarify" | "close" = "none";
  let replyOverride: string | null = null;
  let ctxPatch: any = {};

  // A) 🚫 NO handoff por emoción
  // En vez de escalar, pedimos aclaración si hay frustración/enfado.
  if (e === "enfado" || e === "frustracion") {
    action = "clarify";
    ctxPatch = { needs_clarify: true, last_emotion: e };
    // replyOverride opcional: normalmente deja que el flujo normal responda.
    // Si quieres forzar una frase corta, descomenta:
    // replyOverride = "Entiendo. ¿Me confirmas qué servicio necesitas (baño, grooming, uñas) y el tamaño de tu perrito (Small, Medium, Large o XL)?";
  }

  // B) Close (solo si no escalamos)
  if (
    action === "none" &&
    e === "entusiasmo" &&
    i &&
    esIntencionDeVenta(i) &&
    lvl === 3
  ) {
    action = "close";
    ctxPatch = { ready_to_close: true, last_emotion: e };
  }

  return { action, replyOverride, ctxPatch };
}
