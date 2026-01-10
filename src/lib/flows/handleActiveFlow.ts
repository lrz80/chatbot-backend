// backend/src/lib/flows/handleActiveFlow.ts
import type { Pool } from "pg";

export type ConversationState = {
  active_flow?: string | null;
  active_step?: string | null;
  context?: any;
};

export type HandleActiveFlowArgs = {
  pool: Pool;

  tenantId: string;
  canal: string;
  senderId: string; // contactoNorm
  userInput: string;
  idiomaDestino: string;

  state: ConversationState;

  // Inyecta envío (WhatsApp, Meta, etc.)
  sendText: (to: string, text: string) => Promise<void>;
};

export async function handleActiveFlow(args: HandleActiveFlowArgs): Promise<boolean> {
  const { pool, tenantId, canal, senderId, userInput, idiomaDestino, state, sendText } = args;

  // Si no hay flow activo, no hacemos nada.
  if (!state?.active_flow || !state?.active_step) return false;

  // ✅ EJEMPLO: tu flow actual en logs
  if (state.active_flow === "generic_sales" && state.active_step === "need") {
    const t = (userInput || "").trim().toLowerCase();

    const elegido =
      t.includes("whats") ? "whatsapp" :
      t.includes("insta") ? "instagram" :
      (t.includes("face") || t.includes("fb")) ? "facebook" :
      null;

    if (!elegido) {
      const msg =
        idiomaDestino === "en"
          ? "Perfect. Which channel do you want to automate: WhatsApp, Instagram, or Facebook?"
          : "Perfecto. ¿Qué canal quieres automatizar: WhatsApp, Instagram o Facebook?";

      await sendText(senderId, msg);

      // mantenemos el flow en "need"
      await upsertConversationState(pool, {
        tenantId,
        canal,
        senderId,
        activeFlow: "generic_sales",
        activeStep: "need",
        context: state.context || {},
      });

      return true;
    }

    const msg2 =
      idiomaDestino === "en"
        ? `Got it: ${elegido}. What do you want to achieve (more leads, faster replies, follow-ups)?`
        : `Listo: ${elegido}. ¿Qué quieres lograr (más clientes, responder rápido, seguimiento)?`;

    await sendText(senderId, msg2);

    const newCtx = { ...(state.context || {}), selected_channel: elegido };

    await upsertConversationState(pool, {
      tenantId,
      canal,
      senderId,
      activeFlow: "generic_sales",
      activeStep: "goal",
      context: newCtx,
    });

    return true;
  }

  // Si el flow no está soportado aquí, no lo manejamos.
  return false;
}

async function upsertConversationState(
  pool: Pool,
  p: {
    tenantId: string;
    canal: string;
    senderId: string;
    activeFlow: string;
    activeStep: string;
    context: any;
  }
) {
  const { tenantId, canal, senderId, activeFlow, activeStep, context } = p;

  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      active_flow = EXCLUDED.active_flow,
      active_step = EXCLUDED.active_step,
      context = EXCLUDED.context,
      updated_at = NOW()
    `,
    [tenantId, canal, senderId, activeFlow, activeStep, JSON.stringify(context || {})]
  );
}
