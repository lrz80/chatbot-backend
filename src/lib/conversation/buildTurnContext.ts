// backend/src/lib/conversation/buildTurnContext.ts
import type { Pool } from "pg";
import { normalizeToNumber, normalizeFromNumber } from "../whatsapp/normalize";
import { resolveTenantFromInbound, type ResolveTenantContext } from "../tenants/resolveTenantFromInbound";

export type Origen = "twilio" | "meta";

export type TurnContext = {
  // Raw inbound
  toRaw: string;
  fromRaw: string;
  userInputRaw: string;
  messageId: string | null;

  // Determinaciones
  origen: Origen;

  // Normalizaciones
  numero: string;        // número negocio (sin whatsapp:/tel:)
  numeroSinMas: string;  // sin "+"
  fromNumber: string;    // número cliente (sin whatsapp:/tel:)
  contactoNorm: string;  // normalizado para DB (solo dígitos/+)

  // ✅ CLAVE ÚNICA PARA conversation_state.sender_id
  senderId: string;

  // Tenant
  tenant: any | null;

  // Opcional: si quieres arrastrar canal/ctx
  canal?: string;
  context?: ResolveTenantContext;
};

function computeOrigen(body: any, context?: ResolveTenantContext): Origen {
  const ctxOrigen = context?.origen;
  if (ctxOrigen === "twilio" || ctxOrigen === "meta") return ctxOrigen;

  // Tu regla actual:
  // - si viene context.canal y no es "whatsapp" => meta
  if (context?.canal && context.canal !== "whatsapp") return "meta";

  // - si llega MessageSid o SmsMessageSid => twilio
  if (body?.MessageSid || body?.SmsMessageSid) return "twilio";

  return "meta";
}

function extractMessageId(body: any): string | null {
  return (
    body?.MessageSid ||
    body?.SmsMessageSid ||
    body?.MetaMessageId ||
    null
  );
}

export async function buildTurnContext(opts: {
  pool: Pool;
  body: any;                      // req.body
  context?: ResolveTenantContext;  // tu WhatsAppContext actual
}): Promise<TurnContext> {
  const { pool, body, context } = opts;

  // 1) Datos básicos (raw)
  const toRaw = String(body?.To || "");
  const fromRaw = String(body?.From || "");
  const userInputRaw = String(body?.Body || "");
  const messageId = extractMessageId(body);

  // 2) Origen
  const origen = computeOrigen(body, context);

  // 3) Normalizaciones números
  const { numero, numeroSinMas } = normalizeToNumber(toRaw);
  const { fromNumber, contactoNorm } = normalizeFromNumber(fromRaw);

  // 4) Tenant (encapsulado)
  const tenant = await resolveTenantFromInbound({
    pool,
    toRaw,
    origen,
    context,
  });

  return {
    toRaw,
    fromRaw,
    userInputRaw,
    messageId,
    origen,
    numero,
    numeroSinMas,
    fromNumber,
    contactoNorm,
    // ✅ FIX CRÍTICO
    senderId: contactoNorm,
    tenant,
    canal: context?.canal,
    context,
  };
}

