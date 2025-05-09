import twilio from "twilio";
import pool from "../db";

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// Función para normalizar número al formato internacional
function normalizarNumero(numero: string): string {
  const limpio = numero.replace(/\D/g, "");
  if (limpio.length === 10) return `+1${limpio}`;
  if (limpio.length === 11 && limpio.startsWith("1")) return `+${limpio}`;
  if (numero.startsWith("+")) return numero;
  return "";
}

/**
 * Envía un mensaje de WhatsApp usando plantilla de contenido de Twilio
 */
export async function sendWhatsApp(
  templateSid: string,
  contactos: { telefono: string }[],
  fromNumber: string,
  tenantId: string,
  campaignId: number,
  templateVars: Record<string, string>
) {
  if (!Array.isArray(contactos) || contactos.length === 0) return;

  for (const contacto of contactos) {
    const telefonoRaw = contacto?.telefono?.trim();
    const telefono = normalizarNumero(telefonoRaw || "");
    if (!telefono) continue;

    const to = `whatsapp:${telefono}`;
    console.log(`📤 Enviando plantilla ${templateSid} a ${to}`);

    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        contentSid: templateSid,
        contentVariables: JSON.stringify(templateVars),
      });

      await pool.query(
        `INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [tenantId, campaignId, message.sid, message.status, telefono, fromNumber]
      );

      console.log(`✅ WhatsApp enviado a ${telefono}`);
    } catch (err: any) {
      console.error(`❌ Error al enviar a ${telefono}: ${err.message}`);
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
