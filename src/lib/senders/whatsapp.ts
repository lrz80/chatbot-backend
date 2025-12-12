// src/lib/senders/whatsapp.ts
import twilio from "twilio";
import pool from "../db";
import fetch from "node-fetch";

console.log("🔐 TWILIO_ACCOUNT_SID: cargada correctamente");
console.log("🔐 TWILIO_AUTH_TOKEN: cargada correctamente");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

// ---------- Helpers ----------
const MAX_WHATSAPP = 3900; // límite seguro (WA ~4096 chars)

function chunkByLimit(text: string, limit = MAX_WHATSAPP): string[] {
  const blocks = (text ?? "").replace(/\r\n/g, "\n").split(/\n\n+/); // cortar por párrafos
  const chunks: string[] = [];
  let cur = "";

  const pushCur = () => {
    if (cur) {
      chunks.push(cur);
      cur = "";
    }
  };

  for (let b of blocks) {
    // si cabe el párrafo en el bloque actual
    if ((cur ? cur.length + 2 : 0) + b.length <= limit) {
      cur = cur ? `${cur}\n\n${b}` : b;
      continue;
    }
    // cerramos bloque actual
    pushCur();

    if (b.length <= limit) {
      cur = b;
      continue;
    }

    // si el párrafo excede, corta por líneas
    const lines = b.split("\n");
    let acc = "";
    for (let line of lines) {
      if ((acc ? acc.length + 1 : 0) + line.length <= limit) {
        acc = acc ? `${acc}\n${line}` : line;
      } else {
        if (acc) chunks.push(acc);
        // último recurso: cortar la línea en rebanadas
        while (line.length > limit) {
          chunks.push(line.slice(0, limit));
          line = line.slice(limit);
        }
        acc = line;
      }
    }
    if (acc) chunks.push(acc);
  }
  pushCur();
  return chunks;
}

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
      const message = await client.messages.create({
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

// ---------- Envíos de SESIÓN (texto libre) unificados: Meta Cloud API → fallback Twilio ----------
export async function enviarWhatsApp(
  telefono: string,
  mensaje: string,
  tenantId: string
): Promise<boolean> {
  const digits = normalizarNumero(telefono); // "18633171646"
  if (!digits) {
    console.warn("❌ Número de destino inválido:", telefono);
    return false;
  }

  const numeroCloud = digits;        // para Cloud API → "18633171646"
  const numeroTwilio = `+${digits}`; // para Twilio   → "+18633171646"

  // dividimos el mensaje largo en trozos seguros para WhatsApp
  const parts = chunkByLimit(mensaje);
  let sentOk = false;

  // 1️⃣ Intentar enviar por Cloud API si el tenant tiene credenciales
  const creds = await obtenerCredencialesMetaWhatsApp(tenantId);

  if (creds) {
    console.log(
      "WHATSAPP ENVIAR (Meta) -> tenantId:",
      tenantId,
      "from phone_number_id:",
      creds.phoneNumberId,
      "to:",
      numeroCloud
    );

    let cloudOk = false;

    try {
      for (const part of parts) {
        const payload = {
          messaging_product: "whatsapp",
          to: numeroCloud, // "18633171646"
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
          console.error(
            "❌ Error Cloud API:",
            json || (await resp.text().catch(() => ""))
          );
        } else {
          console.log(`✅ WhatsApp (Meta) enviado a ${numeroCloud}`, waId);
          cloudOk = true;
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
            // usamos el número real si está, si no el phone_number_id
            creds.fromNumber || creds.phoneNumberId,
          ]
        );
      }
    } catch (err: any) {
      console.error(
        `❌ Error enviando por Cloud API a ${numeroCloud}:`,
        err?.message || err
      );
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

    // Si al menos una parte se envió bien por Cloud, consideramos éxito y NO usamos fallback
    if (cloudOk) {
      return true;
    }

    console.warn(
      "⚠️ Cloud API no pudo enviar el mensaje (ninguna parte OK). Intentando fallback Twilio..."
    );
  }

  // 2️⃣ Fallback: enviar por Twilio si NO hubo éxito en Cloud
  const fromTwilio = await obtenerNumeroDeTenant(tenantId);
  if (!fromTwilio) {
    console.warn(
      "❌ No se enviará mensaje: tenant sin Cloud exitoso y sin twilio_number configurado. tenantId=",
      tenantId
    );
    return false;
  }

  console.log(
    "WHATSAPP ENVIAR (Twilio fallback) -> tenantId:",
    tenantId,
    "from twilio_number:",
    fromTwilio,
    "to:",
    numeroTwilio
  );

  try {
    for (const part of parts) {
      const message = await client.messages.create({
        from: `whatsapp:${fromTwilio}`,
        to: `whatsapp:${numeroTwilio}`, // "whatsapp:+18633171646"
        body: part,
      });

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [tenantId, message.sid, message.status, numeroTwilio, fromTwilio]
      );

      console.log(`✅ WhatsApp (Twilio) enviado a ${numeroTwilio}`, message.sid);
      sentOk = true;
    }
  } catch (err: any) {
    console.error(
      `❌ Error enviando por Twilio a ${numeroTwilio}:`,
      err?.message || err
    );
    await pool.query(
      `INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, null, 'failed', $2, $3, $4, $5, NOW())`,
      [
        tenantId,
        numeroTwilio,
        fromTwilio,
        err?.code || null,
        err?.message || "Error desconocido",
      ]
    );
  }

  return sentOk;
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
