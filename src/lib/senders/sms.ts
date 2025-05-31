import twilio from "twilio";
import pool from "../db";

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// ✅ Normaliza al formato E.164
function normalizarNumero(numero: string): string {
  const limpio = numero.trim();
  if (/^\+\d{10,15}$/.test(limpio)) return limpio;

  const soloNumeros = limpio.replace(/\D/g, "");
  if (soloNumeros.length === 10) return `+1${soloNumeros}`;
  if (soloNumeros.length === 11 && soloNumeros.startsWith("1")) return `+${soloNumeros}`;
  if (soloNumeros.startsWith("00")) return `+${soloNumeros.slice(2)}`;

  return `+${soloNumeros}`; // fallback
}

const callbackBaseUrl = process.env.API_BASE_URL;

if (!callbackBaseUrl) {
  console.warn("⚠️ API_BASE_URL no está definida en el entorno.");
} else {
  console.log("📤 Usando callback URL:", `${callbackBaseUrl}/api/webhook/sms-status`);
}

const defaultAamyFromNumber = '+14455451224';

export async function sendSMS(
  mensaje: string,
  destinatarios: string[],
  fromNumber: string, // Mantén este argumento para compatibilidad
  tenantId: string,
  campaignId: number
) {
  // Usa el número de Aamy AI solo si el tenant es AAMYAI
  const realFromNumber = tenantId === 'AAMYAI' ? defaultAamyFromNumber : fromNumber;

  for (const rawTo of destinatarios) {
    const to = normalizarNumero(rawTo);

    if (!/^\+\d{10,15}$/.test(to)) {
      console.warn(`❌ Número inválido para SMS: ${rawTo}`);
      continue;
    }

    if (to === realFromNumber) {
      console.warn(`⚠️ El número de destino y origen son iguales: ${to}`);
      continue;
    }

    try {
      const message = await client.messages.create({
        body: mensaje,
        from: realFromNumber,
        to,
        statusCallback: `${callbackBaseUrl}/api/webhook/sms-status?campaign_id=${campaignId}`,
      });

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, campaignId, message.sid, message.status, to, realFromNumber, new Date().toISOString()]
      );

      console.log(`✅ SMS enviado a ${to} (SID: ${message.sid})`);
    } catch (error: any) {
      console.error(`❌ Error enviando SMS a ${to}:`, error.message);

      await pool.query(
        `INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          campaignId,
          null,
          'failed',
          to,
          realFromNumber,
          error.code || null,
          error.message || "Error desconocido",
          new Date().toISOString(),
        ]
      );
    }
  }
}
