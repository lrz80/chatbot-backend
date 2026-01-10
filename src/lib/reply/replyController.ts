// backend/src/lib/reply/replyController.ts
import pool from "../db"; // ajusta si tu db está en otra ruta
import { safeEnviarWhatsApp } from "../senders/whatsappSafe"; // ajusta
import { saveAssistantMessageAndEmit } from "../messages/saveAssistantMessageAndEmit"; // ajusta
import { rememberAfterReply } from "../memory/rememberAfterReply"; // ajusta

type ReplyMeta = {
  reason: string;                 // "faq", "flow", "openai", "fallback", etc.
  intent?: string | null;
  tags?: string[];
};

type ReplyControllerInit = {
  tenantId: string;
  canal: "whatsapp" | string;
  senderId: string;              // contactoNorm
  messageId: string | null;
  idiomaDestino?: string | null;
};

type ReplyPayload = {
  text: string;
  meta: ReplyMeta;
};

export function createReplyController(init: ReplyControllerInit) {
  let payload: ReplyPayload | null = null;

  function setReply(text: string, reason: string, intent?: string | null, tags?: string[]) {
    if (!text || !text.trim()) return;
    // Mantén SIEMPRE la primera respuesta seteada si quieres evitar sobre-escrituras.
    // Si prefieres "última gana", cambia la condición.
    if (payload) return;

    payload = { text, meta: { reason, intent: intent ?? null, tags: tags ?? [] } };
  }

  function hasReply() {
    return !!payload?.text;
  }

  function getReply() {
    return payload?.text ?? null;
  }

  async function finalize() {
    if (!payload?.text) return { ok: false, skipped: true as const };

    const out = payload.text.trim();

    // 1) enviar
    await safeEnviarWhatsApp({
      tenantId: init.tenantId,
      to: init.senderId,
      body: out,
    });

    // 2) guardar + emitir
    await saveAssistantMessageAndEmit({
      tenantId: init.tenantId,
      canal: init.canal,
      fromNumber: init.senderId,
      messageId: init.messageId,
      content: out,
      // si tu función soporta extras, pásalos aquí
    });

    // 3) memoria (siempre, en un único lugar)
    await rememberAfterReply({
      tenantId: init.tenantId,
      canal: init.canal,
      senderId: init.senderId,
      reply: out,
      reason: payload.meta.reason,
      intent: payload.meta.intent,
    });

    return { ok: true, skipped: false as const, reply: out, meta: payload.meta };
  }

  return { setReply, hasReply, getReply, finalize };
}
