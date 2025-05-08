// src/lib/senders/sms.ts

import twilio from "twilio";
import pool from "../db";

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

// ✅ Función para normalizar número al formato E.164
function normalizarNumero(numero: string): string {
  const limpio = numero.trim();

  // Ya viene en formato correcto
  if (/^\+\d{10,15}$/.test(limpio)) return limpio;

  const soloNumeros = limpio.replace(/\D/g, "");

  if (soloNumeros.length === 10) return `+1${soloNumeros}`; // EE.UU.
  if (soloNumeros.length === 11 && soloNumeros.startsWith("1")) return `+${soloNumeros}`;
  if (soloNumeros.startsWith("00")) return `+${soloNumeros.slice(2)}`;
  
  return `+${soloNumeros}`; // fallback
}

export async function sendSMS(
  mensaje: string,
  destinatarios: string[],
  fromNumber: string,
  tenantId: string,
  campaignId: number
) {
  for (const rawTo of destinatarios) {
    const to = normalizarNumero(rawTo);
    console.log(`📤 Intentando enviar SMS a: ${to} desde ${fromNumber}`);

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
    } catch (error: any) {
      console.error("❌ Error enviando SMS:", error.message);

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
