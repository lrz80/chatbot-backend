import twilio from "twilio";
import pool from "../db";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;
const client = twilio(accountSid, authToken);

// ✅ Función para normalizar número al formato internacional
function normalizarNumero(numero: string): string {
  const limpio = numero.replace(/\D/g, "");
  if (limpio.length === 10) return `+1${limpio}`; // EE.UU.
  if (limpio.length === 11 && limpio.startsWith("1")) return `+${limpio}`;
  if (numero.startsWith("+")) return numero;
  return ""; // inválido
}

/**
 * Envía un mensaje de WhatsApp a una lista de destinatarios usando el número Twilio del tenant.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { telefono: string }
 * @param fromNumber Número de Twilio del tenant (formato: whatsapp:+123456789)
 * @param tenantId ID del tenant (para logging)
 * @param campaignId ID de la campaña (para logging)
 */
export async function sendWhatsApp(
  contenido: string,
  contactos: { telefono: string }[],
  fromNumber: string,
  tenantId: string,
  campaignId: number
) {
  if (!Array.isArray(contactos) || contactos.length === 0) {
    console.warn("⚠️ Lista de contactos vacía o inválida.");
    return;
  }

  for (const contacto of contactos) {
    const telefonoRaw = contacto?.telefono?.trim();
    const telefono = normalizarNumero(telefonoRaw || "");

    if (!telefono) {
      console.warn(`⚠️ Número inválido o no convertible: ${telefonoRaw}`);
      continue;
    }

    const to = `whatsapp:${telefono}`;
    console.log(`📤 Enviando WhatsApp a ${to} desde ${fromNumber}`);

    try {
      const message = await client.messages.create({
        body: contenido,
        from: fromNumber,
        to,
      });

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [tenantId, campaignId, message.sid, message.status, telefono, fromNumber]
      );

      console.log(`✅ WhatsApp enviado a ${telefono} (SID: ${message.sid})`);
    } catch (err: any) {
      console.error(`❌ Error enviando a ${telefono}:`, err?.message || err);

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, null, 'failed', $3, $4, $5, $6, NOW())`,
        [
          tenantId,
          campaignId,
          telefono,
          fromNumber,
          err?.code || null,
          err?.message || "Error desconocido",
        ]
      );
    }
  }
}
