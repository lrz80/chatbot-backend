// backend/src/lib/conversation/finalizeReply.ts
import type { Canal } from '../../lib/detectarIntencion'; 

type FinalizeDeps = {
  // Sender/transport
  safeSend: (
    tenantId: string,
    canal: Canal,
    messageId: string | null,
    fromNumber: string,
    reply: string
  ) => Promise<boolean>;

  // Persistencia
  setConversationState: (
    tenantId: string,
    canal: Canal,
    senderKey: string,
    state: { activeFlow: string; activeStep: string; context: any }
  ) => Promise<void>;

  saveAssistantMessageAndEmit: (args: {
    tenantId: string;
    canal: Canal;
    fromNumber: string;
    messageId: string | null;
    content: string;
  }) => Promise<void>;

  rememberAfterReply: (args: {
    tenantId: string;
    senderId: string;
    idiomaDestino: "es" | "en";
    userText: string;
    assistantText: string;
    lastIntent: string | null;
  }) => Promise<void>;
};

type FinalizeInput = {
  handled: boolean;
  reply: string | null;
  replySource: string | null;
  lastIntent: string | null;

  tenantId: string;
  canal: Canal;
  messageId: string | null;
  fromNumber: string; // número real del cliente (sin whatsapp:)
  contactoNorm: string; // llave normalizada
  userInput: string;

  idiomaDestino: "es" | "en";

  // snapshot estado conversacional (lo que tengas en memoria al final del turno)
  activeFlow: string;
  activeStep: string;
  convoCtx: any;

  // si manejas un fallback separado, pasa aquí el valor final
  intentFallback: string | null;

  // callback para mantener sync en el webhook si quieres
  onAfterOk?: (nextCtx: any) => void;
};

export async function finalizeReply(
  input: FinalizeInput,
  deps: FinalizeDeps
): Promise<void> {
  const {
    handled,
    reply,
    replySource,
    lastIntent,
    tenantId,
    canal,
    messageId,
    fromNumber,
    contactoNorm,
    userInput,
    idiomaDestino,
    activeFlow,
    activeStep,
    convoCtx,
    intentFallback,
    onAfterOk,
  } = input;

  if (!handled || !reply) return;

  // ✅ Sender único para estado/memoria
  const senderKey = contactoNorm || fromNumber || "anónimo";

  const nextCtx = {
    ...(convoCtx && typeof convoCtx === "object" ? convoCtx : {}),
    last_reply_source: replySource || null,
    last_intent: (lastIntent || intentFallback || null),
    last_assistant_text: reply,
    last_user_text: userInput,
    last_turn_at: new Date().toISOString(),
  };

  const ok = await deps.safeSend(tenantId, canal, messageId, fromNumber, reply);

  if (!ok) {
    console.warn("⚠️ finalizeReply: safeSend falló; no guardo assistant/memoria/estado.", {
      replySource,
    });
    return;
  }

  // 1) state (una sola vez)
  await deps.setConversationState(tenantId, canal, senderKey, {
    activeFlow: activeFlow || "generic_sales",
    activeStep: activeStep || "start",
    context: nextCtx,
  });

  // 2) mensaje assistant + emit
  await deps.saveAssistantMessageAndEmit({
    tenantId,
    canal,
    fromNumber: senderKey,
    messageId,
    content: reply,
  });

  // 3) memoria
  await deps.rememberAfterReply({
    tenantId,
    senderId: senderKey,
    idiomaDestino,
    userText: userInput,
    assistantText: reply,
    lastIntent: lastIntent || intentFallback || null,
  });

  if (onAfterOk) onAfterOk(nextCtx);
}
