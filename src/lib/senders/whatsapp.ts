// src/lib/senders/whatsapp.ts
import twilio from "twilio";
import pool from "../db";

console.log("🔐 TWILIO_ACCOUNT_SID: cargada correctamente");
console.log("🔐 TWILIO_AUTH_TOKEN: cargada correctamente");

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// ---------- Helpers ----------
const MAX_WHATSAPP = 3900; // límite seguro (WA ~4096 chars)

function chunkByLimit(text: string, limit = MAX_WHATSAPP): string[] {
  const blocks = (text ?? "").replace(/\r\n/g, "\n").split(/\n\n+/); // cortar por párrafos
  const chunks: string[] = [];
  let cur = "";

  const pushCur = () => { if (cur) { chunks.push(cur); cur = ""; } };

  for (let b of blocks) {
    // si cabe el párrafo en el bloque actual
    if ((cur ? cur.length + 2 : 0) + b.length <= limit) {
      cur = cur ? `${cur}\n\n${b}` : b;
      continue;
    }
    // cerramos bloque actual
    pushCur();

    if (b.length <= limit) { cur = b; continue; }

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

// normaliza número al formato internacional básico (EE.UU. por defecto)
function normalizarNumero(numero: string): string {
  const limpio = (numero || "").replace(/\D/g, "");
  if (limpio.length === 10) return `+1${limpio}`;                   // 10 dígitos → +1
  if (limpio.length === 11 && limpio.startsWith("1")) return `+${limpio}`;
  if ((numero || "").startsWith("+")) return numero;                 // ya viene E.164
  return "";
}

// ---------- Envíos por TEMPLATE (Content API) ----------
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
  const from = fromNumber.startsWith("whatsapp:") ? fromNumber : `whatsapp:${fromNumber}`;

  for (const contacto of contactos) {
    const telefonoRaw = contacto?.telefono?.trim();
    const telefono = normalizarNumero(telefonoRaw || "");
    if (!telefono) continue;

    const to = `whatsapp:${telefono}`;
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
        [tenantId, campaignId, message.sid, message.status, telefono, from]
      );

      console.log(`✅ WhatsApp (template) enviado a ${telefono}`);
    } catch (err: any) {
      console.error(`❌ Error al enviar a ${telefono}: ${err.message}`);
      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, null, 'failed', $3, $4, $5, $6, NOW())`,
        [tenantId, campaignId, telefono, from, err?.code || null, err?.message || "Error desconocido"]
      );
    }
  }
}

// ---------- Envíos de SESIÓN (texto libre) ----------
export async function enviarWhatsApp(
  telefono: string,
  mensaje: string,
  tenantId: string
) {
  const fromNumber = await obtenerNumeroDeTenant(tenantId); // número real del tenant (E.164, sin prefijo)
  console.log("WHATSAPP ENVIAR -> tenantId:", tenantId, "fromNumber:", fromNumber);
  const numero = normalizarNumero(telefono);
  if (!numero || !fromNumber) {
    console.warn("❌ Número inválido o tenant sin número asignado");
    return;
  }

  const from = `whatsapp:${fromNumber}`;
  const to = `whatsapp:${numero}`;

  // 👉 chunking aquí: preserva \n y evita cortes "raros"
  const parts = chunkByLimit(mensaje);

  try {
    for (const part of parts) {
      const msg = await client.messages.create({
        from,
        to,
        body: part, // Twilio respeta \n
      });

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [tenantId, msg.sid, msg.status, numero, fromNumber]
      );
    }

    console.log(`✅ Mensaje(s) enviados a ${to} (${parts.length} parte/s)`);
  } catch (err: any) {
    console.error(`❌ Error enviando a ${to}: ${err.message}`);
    await pool.query(
      `INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, null, 'failed', $2, $3, $4, $5, NOW())`,
      [tenantId, numero, fromNumber, err.code || null, err.message || "Error desconocido"]
    );
  }
}

// ---------- Utilidad ----------
async function obtenerNumeroDeTenant(tenantId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT twilio_number FROM tenants WHERE id = $1 LIMIT 1",
    [tenantId]
  );
  return result.rows[0]?.twilio_number || null;
}
