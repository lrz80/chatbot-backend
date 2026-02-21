// src/lib/senders/whatsapp.ts
import twilio from "twilio";
import pool from "../db";
import fetch from "node-fetch";
import { splitMessage } from "../messages/splitMessage";

console.log("🔐 TWILIO_ACCOUNT_SID: cargada correctamente");
console.log("🔐 TWILIO_AUTH_TOKEN: cargada correctamente");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

// normaliza número a SOLO dígitos E.164 (sin "whatsapp:" ni "+")
function normalizarNumero(numero: string): string {
  if (!numero) return "";

  let raw = numero.trim();

  // Si viene de Twilio: "whatsapp:+1863..."
  if (raw.toLowerCase().startsWith("whatsapp:")) {
    raw = raw.slice("whatsapp:".length);
  }

  // Si viene con "+": "+1863..."
  if (raw.startsWith("+")) {
    raw = raw.slice(1);
  }

  // Nos quedamos sólo con dígitos
  const digits = raw.replace(/\D/g, "");

  // Rango típico E.164: 8–15 dígitos
  if (digits.length < 8 || digits.length > 15) {
    return "";
  }

  return digits; // ej: "18633171646"
}

// ---------- Utilidad Twilio: obtener número asignado al tenant (para campañas / fallback sesión) ----------
async function obtenerNumeroDeTenant(tenantId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT twilio_number FROM tenants WHERE id = $1 LIMIT 1",
    [tenantId]
  );
  return result.rows[0]?.twilio_number || null;
}

// ---------- Twilio: client por tenant (subaccount) ----------
async function getTwilioClientForTenant(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT twilio_subaccount_sid, twilio_subaccount_auth_token
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const sid = rows[0]?.twilio_subaccount_sid || null;
  const token = rows[0]?.twilio_subaccount_auth_token || null;

  // ✅ Si el tenant tiene subaccount real, usamos ese client
  if (sid && token) {
    return twilio(sid, token);
  }

  // ⚠️ Fallback: master (no recomendado, pero evita romper si un tenant aún no tiene token guardado)
  console.warn(
    "⚠️ Tenant sin twilio_subaccount_sid/auth_token -> usando client MASTER. tenantId=",
    tenantId
  );
  return client;
}

// ---------- WhatsApp: modo activo + estado del canal ----------
async function obtenerModoYEstadoWhatsApp(tenantId: string): Promise<{
  mode: "twilio" | "cloudapi";
  status: "enabled" | "disabled";
}> {
  const result = await pool.query(
    `SELECT whatsapp_mode, whatsapp_status
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );

  const row = result.rows[0] || {};
  const modeRaw = String(row.whatsapp_mode || "twilio").trim().toLowerCase();
  const statusRaw = String(row.whatsapp_status || "disabled").trim().toLowerCase();

  const mode: "twilio" | "cloudapi" =
    modeRaw === "cloudapi" ? "cloudapi" : "twilio";

  const status: "enabled" | "disabled" =
  (statusRaw === "enabled" || statusRaw === "active" || statusRaw === "connected")
    ? "enabled"
    : "disabled";

  return { mode, status };
}

// ---------- Envíos por TEMPLATE (Content API con Twilio) ----------
export async function sendWhatsApp(
  templateSid: string,
  contactos: { telefono: string }[],
  fromNumber: string, // puede venir con o sin prefijo
  tenantId: string,
  campaignId: number,
  templateVars: Record<string, string>
) {
  if (!Array.isArray(contactos) || contactos.length === 0) return;

    const { mode, status } = await obtenerModoYEstadoWhatsApp(tenantId);

  if (status !== "enabled") {
    console.log("⛔ WhatsApp deshabilitado (campaña). tenantId=", tenantId);
    return;
  }

  if (mode !== "twilio") {
    console.log("⛔ Campañas WhatsApp por template solo soportan Twilio. whatsapp_mode=", mode, "tenantId=", tenantId);
    return;
  }

  // asegurar prefijo whatsapp:
  const from = fromNumber.startsWith("whatsapp:")
    ? fromNumber
    : `whatsapp:${fromNumber}`;

  for (const contacto of contactos) {
    const telefonoRaw = contacto?.telefono?.trim();
    const digits = normalizarNumero(telefonoRaw || "");
    if (!digits) continue;

    const toE164 = `+${digits}`;                 // "+18633171646"
    const to = `whatsapp:${toE164}`;            // "whatsapp:+18633171646"
    console.log(`📤 Enviando plantilla ${templateSid} a ${to}`);

    try {
      const twilioClient = await getTwilioClientForTenant(tenantId);

      const message = await twilioClient.messages.create({
        from,
        to,
        contentSid: templateSid,
        contentVariables: JSON.stringify(templateVars),
      });


      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [tenantId, campaignId, message.sid, message.status, toE164, from]
      );

      console.log(`✅ WhatsApp (template) enviado a ${toE164}`);
    } catch (err: any) {
      console.error(`❌ Error al enviar a ${toE164}: ${err.message}`);
      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, null, 'failed', $3, $4, $5, $6, NOW())`,
        [
          tenantId,
          campaignId,
          toE164,
          from,
          err?.code || null,
          err?.message || "Error desconocido",
        ]
      );

    }
  }
}

// ---------- Credenciales WhatsApp Cloud API (Meta) ----------
async function obtenerCredencialesMetaWhatsApp(tenantId: string): Promise<{
  phoneNumberId: string;
  token: string;
  fromNumber: string | null;
} | null> {
  const result = await pool.query(
    `SELECT whatsapp_phone_number_id, whatsapp_access_token, whatsapp_phone_number
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );

  const row = result.rows[0];
  if (!row?.whatsapp_phone_number_id || !row?.whatsapp_access_token) {
    return null;
  }

  return {
    phoneNumberId: row.whatsapp_phone_number_id,
    token: row.whatsapp_access_token,
    fromNumber: row.whatsapp_phone_number || null,
  };
}

async function enviarPorCloudApi(
  tenantId: string,
  numeroCloud: string,
  parts: string[]
): Promise<boolean> {
  const creds = await obtenerCredencialesMetaWhatsApp(tenantId);
  if (!creds) {
    console.warn("⚠️ Cloud API: tenant sin credenciales (phone_number_id/token). tenantId=", tenantId);
    return false;
  }

  console.log(
    "WHATSAPP ENVIAR (Meta) -> tenantId:",
    tenantId,
    "from phone_number_id:",
    creds.phoneNumberId,
    "to:",
    numeroCloud
  );

  let ok = false;

  try {
    for (const part of parts) {
      const payload = {
        messaging_product: "whatsapp",
        to: numeroCloud,
        type: "text",
        text: { body: part },
      };

      const url = `https://graph.facebook.com/v20.0/${creds.phoneNumberId}/messages`;

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json = (await resp.json().catch(() => ({} as any))) as any;
      const waId = json?.messages?.[0]?.id || null;
      const status = resp.ok ? "sent" : "failed";

      if (!resp.ok) {
        console.error("❌ Error Cloud API:", json || (await resp.text().catch(() => "")));
      } else {
        console.log(`✅ WhatsApp (Meta) enviado a ${numeroCloud}`, waId);
        ok = true;
      }

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          tenantId,
          waId,
          status,
          numeroCloud,
          creds.fromNumber || creds.phoneNumberId,
        ]
      );
    }
  } catch (err: any) {
    console.error(`❌ Error enviando por Cloud API a ${numeroCloud}:`, err?.message || err);
    await pool.query(
      `INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, null, 'failed', $2, $3, $4, $5, NOW())`,
      [
        tenantId,
        numeroCloud,
        creds.fromNumber || creds.phoneNumberId,
        err?.code || null,
        err?.message || "Error desconocido",
      ]
    );
  }

  return ok;
}

async function enviarPorTwilio(
  tenantId: string,
  numeroTwilioE164: string,
  parts: string[]
): Promise<boolean> {
  const fromTwilio = await obtenerNumeroDeTenant(tenantId);
  if (!fromTwilio) {
    console.warn("⚠️ Twilio: tenant sin twilio_number configurado. tenantId=", tenantId);
    return false;
  }

  console.log(
    "WHATSAPP ENVIAR (Twilio) -> tenantId:",
    tenantId,
    "from twilio_number:",
    fromTwilio,
    "to:",
    numeroTwilioE164
  );

  let ok = false;

  const fromFixed = fromTwilio.toLowerCase().startsWith("whatsapp:")
  ? fromTwilio
  : `whatsapp:${fromTwilio.startsWith("+") ? fromTwilio : `+${normalizarNumero(fromTwilio)}`}`;

  const twilioClient = await getTwilioClientForTenant(tenantId);

  try {
    for (const part of parts) {
      const message = await twilioClient.messages.create({
        from: fromFixed,
        to: `whatsapp:${numeroTwilioE164}`,
        body: part,
      });

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [tenantId, message.sid, message.status, numeroTwilioE164, fromTwilio]
      );

      console.log(`✅ WhatsApp (Twilio) enviado a ${numeroTwilioE164}`, message.sid);
      ok = true;
    }
  } catch (err: any) {

    console.error(`❌ Error enviando por Twilio a ${numeroTwilioE164}:`, err?.message || err);
    await pool.query(
      `INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, null, 'failed', $2, $3, $4, $5, NOW())`,
      [
        tenantId,
        numeroTwilioE164,
        fromTwilio,
        err?.code || null,
        err?.message || "Error desconocido",
      ]
    );
  }

  return ok;
}

export async function enviarWhatsApp(
  telefono: string,
  mensaje: string,
  tenantId: string
): Promise<boolean> {
  const digits = normalizarNumero(telefono);
  if (!digits) {
    console.warn("❌ Número de destino inválido:", telefono);
    return false;
  }

  // ✅ 1) respetar estado y proveedor activo
  const { mode, status } = await obtenerModoYEstadoWhatsApp(tenantId);

  if (status !== "enabled") {
    console.log("⛔ WhatsApp deshabilitado para tenant. tenantId=", tenantId, "status=", status);
    return false;
  }

  // ✅ 2) dividir mensaje en partes de ~1000 caracteres (como el bot viejo)
  const parts = splitMessage(mensaje, 1000);

  // ✅ 3) enviar SOLO por el proveedor activo
  if (mode === "cloudapi") {
    // Cloud API usa número SIN "+"
    const numeroCloud = digits;
    return await enviarPorCloudApi(tenantId, numeroCloud, parts);
  }

  // Twilio usa E.164 con "+"
  const numeroTwilioE164 = `+${digits}`;
  return await enviarPorTwilio(tenantId, numeroTwilioE164, parts);
}

// 👇 Wrapper para el interceptor (firma Promise<void>)
export async function enviarWhatsAppVoid(
  telefono: string,
  mensaje: string,
  tenantId: string
): Promise<void> {
  try {
    await enviarWhatsApp(telefono, mensaje, tenantId);
  } catch (e) {
    console.error("❌ enviarWhatsAppVoid error:", e);
  }
}
