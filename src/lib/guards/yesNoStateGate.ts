// backend/src/lib/guards/yesNoStateGate.ts
import type { Pool } from "pg";
import type { Canal } from '../../lib/detectarIntencion';
import type { GateResult } from "../conversation/stateMachine";
import type { TurnEvent } from "../conversation/stateMachine"; // si TurnEvent está exportado ahí

type Idioma = "es" | "en";

export type YesNoGateResult =
  | { action: "continue" }
  | { action: "silence"; reason: "awaiting_yesno_but_empty" }
  | {
      action: "reply";
      replySource: "yesno-clarify" | "yesno-unsupported" | "yesno-handled";
      intent: "yesno";
      facts: Record<string, any>;
      transition?: { flow?: string; step?: string; patchCtx?: any };
    }
  | {
      action: "transition";
      transition: { flow?: string; step?: string; patchCtx?: any };
    };

function normalize(text: string) {
  return (text || "").trim().toLowerCase();
}

function parseYesNo(text: string): "yes" | "no" | "unknown" {
  const t = normalize(text);

  // En la práctica: "si", "sí", "ok", "dale", "yes", "y", etc.
  const YES =
    /^(s[ií]|si|sí|ok|okay|dale|de una|claro|perfecto|listo|va|vamos|y|yes|yeah|yep|sure|confirmo|confirmar|confirm)\b/;

  // "no", "nel", "nope", etc.
  const NO = /^(no|nop|nope|nel|n)\b/;

  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";

  // a veces viene "si, quiero..." o "no gracias..."
  if (/\b(s[ií]|sí|si|yes)\b/.test(t)) return "yes";
  if (/\b(no|nope)\b/.test(t)) return "no";

  return "unknown";
}

/**
 * YES/NO Gate:
 * Lee conversation_state (o ctx) para ver si estamos "awaiting yes/no".
 * Si el usuario responde YES/NO, aplica transition/patchCtx.
 * Si no, pide aclaración (sin hardcode: devuelve facts).
 *
 * Importante: NO asume flows específicos; se guía por ctx.
 */
export async function yesNoStateGate(event: TurnEvent): Promise<GateResult> {
    const {
    pool,
    tenantId,
    canal,
    senderId,
    userInput,
    idiomaDestino,
    clearAwaiting,
    } = event as any;

  const awaitingKey = "awaiting_yesno";

  const inputNorm = normalize(userInput);
  if (!inputNorm) {
    // si estás esperando yes/no pero vino vacío, silencio (evita loops)
    // (igual esto solo aplica si realmente hay awaiting)
  }

  // 1) Leer ctx del estado conversacional
  let ctx: any = null;

  try {
        const { rows } = await pool.query(
      `
      SELECT context
      FROM conversation_state
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      LIMIT 1
      `,
      [tenantId, canal, senderId]
    );

    ctx = rows[0]?.context ?? null;
  } catch {
    // Si no existe tabla en algún entorno, no bloqueamos el pipeline
    return { action: "continue" };
  }

  const awaiting = Boolean(ctx && ctx[awaitingKey]);
  if (!awaiting) return { action: "continue" };

  // 2) Parse YES/NO
  const yn = parseYesNo(userInput);

  if (!inputNorm) {
    return { action: "silence", reason: "awaiting_yesno_but_empty" };
  }

  if (yn === "unknown") {
    // Pedir aclaración SIN hardcode: solo facts
    return {
      action: "reply",
      replySource: "yesno-clarify",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_REQUIRED",
        LANGUAGE: idiomaDestino,
        QUESTION_CONTEXT: ctx?.yesno_context ?? null, // opcional si lo guardas
        EXPECTED_ANSWERS: ["yes", "no"],
        INSTRUCTION: "ASK_USER_TO_REPLY_YES_OR_NO_ONLY",
      },
    };
  }

  // 3) Si hay handlers declarativos en ctx, los usamos
  // Ejemplo recomendado en tu ctx:
  // ctx.awaiting_yesno = true
  // ctx.on_yes = { flow, step, patchCtx }
  // ctx.on_no  = { flow, step, patchCtx }
  const onYes = ctx?.on_yes ?? null;
  const onNo = ctx?.on_no ?? null;

  const picked = yn === "yes" ? onYes : onNo;

  // Limpiar awaiting si tienes helper, o lo dejamos para tu transition()
  if (clearAwaiting) {
    await clearAwaiting({ tenantId, canal, senderId });
  } else {
    // Intento best-effort: patch ctx para apagar awaiting
    try {
      await pool.query(
        `
        UPDATE conversation_state
        SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object($4, false),
            updated_at = now()
        WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
        `,
        [tenantId, canal, senderId, awaitingKey]
      );
    } catch {
      // no bloquea
    }
  }

  // 4) Si hay acción declarada, devolvemos transition
  if (picked) {
    return {
      action: "reply",
      replySource: "yesno-handled",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_RECEIVED",
        LANGUAGE: idiomaDestino,
        ANSWER: yn,
        // no copy, solo estado
        NEXT: picked,
      },
      transition: {
        flow: picked.flow,
        step: picked.step,
        patchCtx: picked.patchCtx ?? { yesno_answer: yn },
      },
    };
  }

  // 5) Si no hay handler en ctx, igual notificamos por facts y seguimos
  return {
    action: "reply",
    replySource: "yesno-unsupported",
    intent: "yesno",
    facts: {
      EVENT: "YESNO_RECEIVED_NO_HANDLER",
      LANGUAGE: idiomaDestino,
      ANSWER: yn,
    },
  };
}
