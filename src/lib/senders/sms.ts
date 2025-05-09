import twilio from "twilio";
import pool from "../db";

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// ✅ Función para normalizar número al formato E.164
function normalizarNumero(numero: string): string {
  const limpio = numero.trim();
  if (/^\+\d{10,15}$/.test(limpio)) return limpio;

  const soloNumeros = limpio.replace(/\D/g, "");

  if (soloNumeros.length === 10) return `+1${soloNumeros}`;
  if (soloNumeros.length === 11 && soloNumeros.startsWith("1")) return `+${soloNumeros}`;
  if (soloNumeros.startsWith("00")) return `+${soloNumeros.slice(2)}`;

  return `+${soloNumeros}`; // fallback
}

// 📨 Función para enviar SMS a una lista de destinatarios ya provistos
export async function sendSMS(
  mensaje: string,
  destinatarios: string[],
  fromNumber: string,
  tenantId: string,
  campaignId: number
) {
  for (const rawTo of destinatarios) {
    const to = normalizarNumero(rawTo);

    if (!/^\+\d{10,15}$/.test(to)) {
      console.warn(`❌ Número inválido para SMS: ${rawTo}`);
      continue;
    }

    try {
      const message = await client.messages.create({
        body: mensaje,
        from: fromNumber,
        to,
      });

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [tenantId, campaignId, message.sid, message.status, to, fromNumber]
      );

      console.log(`✅ SMS enviado a ${to} (SID: ${message.sid})`);
    } catch (error: any) {
      console.error(`❌ Error enviando SMS a ${to}:`, error.message);

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, null, 'failed', $3, $4, $5, $6, NOW())`,
        [
          tenantId,
          campaignId,
          to,
          fromNumber,
          error.code || null,
          error.message || "Error desconocido",
        ]
      );
    }
  }
}
