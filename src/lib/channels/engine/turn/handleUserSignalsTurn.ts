// backend/src/lib/channels/engine/turn/handleUserSignalsTurn.ts

import { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";

import { detectarIntencion } from "../../../detectarIntencion";
import { detectarEmocion } from "../../../detectarEmocion";
import { applyEmotionTriggers } from "../../../guards/emotionTriggers";
import { saveUserMessageAndEmit } from "../messages/saveUserMessageAndEmit";
import { getMemoryValue } from "../../../clientMemory";
import { setHumanOverride } from "../../../humanOverride/setHumanOverride";
import { isExplicitHumanRequest } from "../../../security/humanOverrideGate";
import { supportGate } from "../../../guards/supportGate";

type TransitionFn = (params: {
  flow?: string;
  step?: string;
  patchCtx?: any;
}) => void;

const PAYMENT_INTENTS = new Set<string>([
  "pago",
  "checkout",
  "payment",
  "compra",
  "comprar",
  "suscripcion",
  "suscripción",
  "subscription",
  "membresia",
  "membresía",
  "plan",
  "paquete",
  "activar_membresia",
]);

function normIntent(x?: string | null) {
  return String(x || "").trim().toLowerCase();
}

export type HandleUserSignalsArgs = {
  pool: Pool;
  tenant: any;
  canal: Canal;
  contactoNorm: string;
  fromNumber: string | null;
  userInput: string;
  messageId: string | null;
  idiomaDestino: Lang;
  promptBase: string;
  convoCtx: any;
  INTENCION_FINAL_CANONICA: string | null;
  transition: TransitionFn;
};

export type HandleUserSignalsResult = {
  detectedIntent: string | null;
  detectedInterest: number | null;
  INTENCION_FINAL_CANONICA: string | null;
  emotion: string | null;
  promptBaseMem: string;
  convoCtx: any;
  handled: boolean; // true = ya respondió (p.ej. human override)
  humanOverrideReply?: string | null;
  humanOverrideSource?: string | null;
};

export async function handleUserSignalsTurn(
  args: HandleUserSignalsArgs
): Promise<HandleUserSignalsResult> {
  const {
    pool,
    tenant,
    canal,
    contactoNorm,
    fromNumber,
    userInput,
    messageId,
    idiomaDestino,
    promptBase,
    transition,
  } = args;

  let { convoCtx, INTENCION_FINAL_CANONICA } = args;

  let detectedIntent: string | null = null;
  let detectedInterest: number | null = null;
  let emotion: string | null = null;
  let promptBaseMem = promptBase;

  let handled = false;
  let humanOverrideReply: string | null = null;
  let humanOverrideSource: string | null = null;

  // ===============================
  // 🎯 INTENCIÓN
  // ===============================
  try {
    const det = await detectarIntencion(userInput, tenant.id, canal);

    const intent = (det?.intencion || "").toString().trim().toLowerCase();
    const levelRaw = Number(det?.nivel_interes);
    const nivel = Number.isFinite(levelRaw)
      ? Math.min(3, Math.max(1, levelRaw))
      : 1;

    console.log("🎯 detectarIntencion =>", {
      intent,
      nivel,
      canal,
      tenantId: tenant.id,
      messageId,
    });

    if (intent) {
      detectedIntent = intent;
      detectedInterest = nivel;
      INTENCION_FINAL_CANONICA = intent;

      transition({
        patchCtx: { last_intent: intent, last_interest_level: nivel },
      });
    }
  } catch (e: any) {
    console.warn("⚠️ detectarIntencion failed:", e?.message, e?.code, e?.detail);
  }

  // ===============================
  // ✅ RESET INTELIGENTE de estado esperando_pago (si cambió de tema)
  // ===============================
  try {
    const intentFinal = normIntent(INTENCION_FINAL_CANONICA || detectedIntent || null);

    const { rows } = await pool.query(
      `SELECT estado
         FROM clientes
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        LIMIT 1`,
      [tenant.id, canal, contactoNorm]
    );

    const estadoActual = normIntent(rows[0]?.estado || null);

    // Si está esperando pago, pero la intención actual NO es de pago → resetear
    if (estadoActual === "esperando_pago" && intentFinal && !PAYMENT_INTENTS.has(intentFinal)) {
      await pool.query(
        `UPDATE clientes
            SET estado = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3`,
        [tenant.id, canal, contactoNorm]
      );

      console.log("[PAYMENT_STATE] reset esperando_pago (intent switch)", {
        tenantId: tenant.id,
        canal,
        contactoNorm,
        intentFinal,
        prevEstado: estadoActual,
      });
    }
  } catch (e: any) {
    console.warn("[PAYMENT_STATE] reset check failed:", e?.message);
  }

  // ===============================
  // 🙂 EMOCIÓN
  // ===============================
  try {
    const emoRaw: any = await detectarEmocion(userInput, idiomaDestino);

    emotion =
      typeof emoRaw === "string"
        ? emoRaw
        : (emoRaw?.emotion || emoRaw?.emocion || emoRaw?.label || null);

    emotion = typeof emotion === "string" ? emotion.trim().toLowerCase() : null;
  } catch {
    // silencio, no es crítico
  }

  if (typeof emotion === "string" && emotion.trim()) {
    transition({ patchCtx: { last_emotion: emotion.trim().toLowerCase() } });
  }

  // ===============================
  // 💾 GUARDAR MENSAJE DEL USUARIO
  // ===============================
  await saveUserMessageAndEmit({
    tenantId: tenant.id,
    canal,
    fromNumber: contactoNorm, // usamos contacto normalizado como key
    messageId,
    content: userInput || "",
    intent: detectedIntent,
    interest_level: detectedInterest,
    emotion,
  });

  // ===============================
  // 🎭 EMOTION TRIGGERS
  // ===============================
  try {
    const trig = await applyEmotionTriggers({
      tenantId: tenant.id,
      canal,
      contacto: contactoNorm,
      emotion,
      intent: detectedIntent,
      interestLevel: detectedInterest,
      userMessage: userInput || null,
      messageId: messageId || null,
    });

    if (trig?.ctxPatch) {
      transition({ patchCtx: trig.ctxPatch });
    }
  } catch (e: any) {
    console.warn("⚠️ applyEmotionTriggers failed:", e?.message);
  }

  // ===============================
  // 🆘 SUPPORT + HUMANO (CORTA PIPELINE)
  // ===============================
  if (!handled) {
    const gate = supportGate({
      canal,
      idiomaDestino,
      userInput,
      detectedIntent,
      emotion,
      tenant,
    });

    if (gate.escalate) {
      // ✅ reply (link soporte)
      humanOverrideReply = gate.reply;
      humanOverrideSource = "support_handoff";
      handled = true;

      // ✅ marca flags para que el resto del engine NO haga fastpath/LLM/followups
      // (multi-tenant, no hardcode)
      convoCtx = {
        ...(convoCtx || {}),
        __stop_pipeline: true,
        __no_followups: true,
        __no_llm: true,
        __no_fastpath: true,
        __no_payment_reset: true,
      };

      transition({ patchCtx: convoCtx });

      // ✅ activar humanOverride SOLO si pidió humano explícitamente (TTL GLOBAL ya viene en gate.minutes)
      if (gate.setHumanOverride) {
        try {
          await setHumanOverride({
            tenantId: tenant.id,
            canal,
            contacto: contactoNorm,
            minutes: gate.minutes, // ✅ GLOBAL (según tu supportGate actual)
            reason: gate.reason,
            source: "support_handoff",
            customerPhone: fromNumber || contactoNorm,
            userMessage: userInput,
            messageId: messageId || null,
          });
        } catch (e: any) {
          console.warn("⚠️ setHumanOverride (support_handoff) failed:", e?.message);
        }
      }
    }
  }

  // ===============================
  // 🧠 MEMORIA → promptBaseMem
  // ===============================
  try {
    const memRaw = await getMemoryValue<any>({
      tenantId: tenant.id,
      canal,
      senderId: contactoNorm,
      key: "facts_summary",
    });

    const memText =
      typeof memRaw === "string"
        ? memRaw
        : memRaw && typeof memRaw === "object" && typeof memRaw.text === "string"
        ? memRaw.text
        : "";

    console.log("🧠 facts_summary =", memText);

    if (memText.trim()) {
      promptBaseMem = [
        promptBase,
        "",
        "MEMORIA_DEL_CLIENTE (usa esto solo si ayuda a responder mejor; no lo inventes):",
        memText.trim(),
      ].join("\n");
    }

    if (!handled && (convoCtx as any)?.needs_clarify) {

      if (emotion === "frustration" || emotion === "anger") {
        promptBaseMem +=
          "\n\nINSTRUCCION: El usuario parece frustrado. Responde con empatía, usa máximo 2 bullets y haz solo 1 pregunta clara para ayudar.";
      } else {
        promptBaseMem +=
          "\n\nINSTRUCCION: El usuario parece confundido. Responde con máximo 2 bullets y haz solo 1 pregunta para aclarar.";
      }

    }
  } catch (e) {
    console.warn("⚠️ No se pudo cargar memoria (getMemoryValue):", e);
  }

  return {
    detectedIntent,
    detectedInterest,
    INTENCION_FINAL_CANONICA,
    emotion,
    promptBaseMem,
    convoCtx,
    handled,
    humanOverrideReply,
    humanOverrideSource,
  };
}