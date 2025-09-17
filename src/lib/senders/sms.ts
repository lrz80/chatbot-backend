// src/lib/senders/sms.ts
import twilio from "twilio";
import pool from "../db";

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// ✅ Normaliza al formato E.164 (US por defecto)
export function normalizarNumero(numero: string): string {
  const limpio = (numero || "").trim();

  // Si viene con prefijo WhatsApp, NO sirve para SMS.
  if (limpio.startsWith("whatsapp:")) return limpio;

  if (/^\+\d{10,15}$/.test(limpio)) return limpio;

  const soloNumeros = limpio.replace(/\D/g, "");
  if (soloNumeros.length === 10) return `+1${soloNumeros}`;
  if (soloNumeros.length === 11 && soloNumeros.startsWith("1")) return `+${soloNumeros}`;
  if (soloNumeros.startsWith("00")) return `+${soloNumeros.slice(2)}`;

  return `+${soloNumeros}`; // fallback
}

const callbackBaseUrl = process.env.API_BASE_URL || process.env.PUBLIC_BASE_URL;
if (!callbackBaseUrl) {
  console.warn("⚠️ API_BASE_URL/PUBLIC_BASE_URL no están definidas; statusCallback quedará vacío.");
} else {
  console.log("📤 Usando callback URL:", `${callbackBaseUrl}/api/webhook/sms-status`);
}

export type SendSmsOpts = {
  mensaje: string;
  destinatarios: string[];       // uno o varios
  fromNumber?: string;           // E.164; opcional si usas messagingServiceSid
  messagingServiceSid?: string;  // alternativo recomendado si tienes 10DLC/Toll-Free configurado
  tenantId: string;
  campaignId?: number | null;    // opcional para campañas; en voz puedes pasar null
};

// ———————————————————————————————————————————————————————
// Overloads: acepta objeto (nuevo) o 5 args posicionales (legacy)
// ———————————————————————————————————————————————————————
export async function sendSMS(opts: SendSmsOpts): Promise<number>;
export async function sendSMS(
  mensaje: string,
  destinatarios: string[],
  fromNumber: string,
  tenantId: string,
  campaignId: number
): Promise<number>;
export async function sendSMS(
  a: any,
  b?: any,
  c?: any,
  d?: any,
  e?: any
): Promise<number> {
  if (typeof a === "string") {
    // Legacy: (mensaje, destinatarios, fromNumber, tenantId, campaignId)
    const opts: SendSmsOpts = {
      mensaje: a,
      destinatarios: b || [],
      fromNumber: c,
      tenantId: d,
      campaignId: e,
    };
    return _sendSMS(opts);
  }
  // Nuevo: objeto
  return _sendSMS(a as SendSmsOpts);
}

// Implementación real (no exportar directamente)
async function _sendSMS({
  mensaje,
  destinatarios,
  fromNumber,
  messagingServiceSid,
  tenantId,
  campaignId = null,
}: SendSmsOpts): Promise<number> {
  let enviados = 0;

  if (!fromNumber && !messagingServiceSid) {
    throw new Error("Debes proveer fromNumber (SMS-capable) o messagingServiceSid");
  }
  if (fromNumber?.startsWith("whatsapp:")) {
    throw new Error("fromNumber apunta a WhatsApp; no puede enviar SMS. Usa un número SMS-capable o messagingServiceSid.");
  }

  const fromE164 = fromNumber ? normalizarNumero(fromNumber) : undefined;

  for (const rawTo of destinatarios) {
    const to = normalizarNumero(rawTo);

    if (to.startsWith("whatsapp:")) {
      console.warn(`❌ Destino viene como WhatsApp (${to}); no se puede enviar SMS.`);
      continue;
    }
    if (!/^\+\d{10,15}$/.test(to)) {
      console.warn(`❌ Número inválido para SMS: ${rawTo} -> ${to}`);
      continue;
    }
    if (fromE164 && to === fromE164) {
      console.warn(`⚠️ El número de destino y origen son iguales: ${to}`);
      continue;
    }

    try {
      const createArgs: any = { body: mensaje, to };
      if (messagingServiceSid) createArgs.messagingServiceSid = messagingServiceSid;
      else if (fromE164) createArgs.from = fromE164;

      if (callbackBaseUrl) {
        createArgs.statusCallback = `${callbackBaseUrl}/api/webhook/sms-status${
          campaignId != null ? `?campaign_id=${campaignId}` : ""
        }`;
      }

      const message = await client.messages.create(createArgs);

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)`,
        [
          tenantId,
          campaignId,
          message.sid,
          message.status,
          to,
          fromE164 ?? `svc:${messagingServiceSid}`,
          new Date().toISOString(),
        ]
      );

      console.log(`✅ SMS enviado a ${to} (SID: ${message.sid}) status=${message.status}`);
      enviados++;
    } catch (error: any) {
      const code = error?.code ?? error?.status ?? "unknown";
      const more = error?.moreInfo ? ` moreInfo=${error.moreInfo}` : "";
      console.error(`❌ Error enviando SMS a ${to}: code=${code} msg=${error?.message || error}${more}`);

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          campaignId,
          "failed",
          to,
          fromE164 ?? `svc:${messagingServiceSid}`,
          code,
          error?.message || "Error desconocido",
          new Date().toISOString(),
        ]
      );
    }
  }

  return enviados;
}

// 🔹 Helper: nombre de marca por tenant (firmas sin hardcode)
async function getTenantBrand(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT COALESCE(
        NULLIF(TRIM(business_name), ''),
        NULLIF(TRIM(nombre_negocio), ''),
        NULLIF(TRIM(name), '')
      ) AS brand
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );
  const brand = (rows?.[0]?.brand || "").toString().trim();
  return brand || "Amy"; // fallback seguro
}

/**
 * 🔗 Enviar por SMS los links del tenant (para flujo de VOZ).
 * - Lee twilio_sms_number (fallback a twilio_voice_number) o messaging_service_sid.
 * - Lee hasta N links de voice_links.
 * - Firma el SMS con la marca del tenant.
 * - Envía UN SMS al caller con los links.
 */
export async function sendTenantLinksBySms({
  tenantId,
  toNumberRaw,
  limit = 5,
}: {
  tenantId: string;
  toNumberRaw: string; // viene de req.body.From (voz)
  limit?: number;
}) {
  // 1) Cargar remitente recomendado y/o servicio
  const { rows: trows } = await pool.query(
    `SELECT twilio_sms_number, twilio_voice_number, messaging_service_sid
     FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!trows.length) throw new Error("Tenant no encontrado");

  const smsFrom = (trows[0].twilio_sms_number as string) || (trows[0].twilio_voice_number as string) || "";
  const messagingServiceSid = (trows[0].messaging_service_sid as string) || undefined;

  if (!smsFrom && !messagingServiceSid) {
    throw new Error("No hay twilio_sms_number/twilio_voice_number SMS-capable ni messaging_service_sid configurado");
  }
  if (smsFrom && smsFrom.startsWith("whatsapp:")) {
    throw new Error("twilio_sms_number/twilio_voice_number es WhatsApp; configura un número SMS-capable o usa messaging_service_sid");
  }

  // 2) Cargar links
  const { rows: links } = await pool.query(
    `SELECT title, url
       FROM voice_links
      WHERE tenant_id = $1
      ORDER BY orden ASC, id ASC
      LIMIT $2`,
    [tenantId, limit]
  );

  if (!links.length) {
    console.log("[sms] No hay links para enviar");
    return { ok: true, sent: 0, note: "no_links" as const };
  }

  const bullets = links.map((r: any, i: number) => `${i + 1}. ${r.title || "Link"}: ${r.url}`).join("\n");
  const brand = await getTenantBrand(tenantId);
  const body = `Gracias por llamar. Te comparto los links:\n${bullets}\n— ${brand}`;

  // 3) Enviar
  const to = normalizarNumero(toNumberRaw);
  const sent = await sendSMS({
    mensaje: body,
    destinatarios: [to],
    fromNumber: smsFrom || undefined,
    messagingServiceSid,
    tenantId,
    campaignId: null, // no es campaña
  });

  return { ok: sent > 0, sent };
}
