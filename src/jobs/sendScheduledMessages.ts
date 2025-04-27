// 📁 src/jobs/sendScheduledMessages.ts

import pool from '../lib/db';
import twilio from 'twilio';

// 📩 Enviar mensajes programados pendientes
export async function sendScheduledMessages(
  accountSidManual?: string,
  authTokenManual?: string
) {
  const accountSid = accountSidManual || process.env.TWILIO_ACCOUNT_SID!;
  const authToken = authTokenManual || process.env.TWILIO_AUTH_TOKEN!;

  if (!accountSid || !authToken) {
    console.error('❌ No se pudo cargar TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en producción.');
    return;
  }

  const client = twilio(accountSid, authToken);

  let enviadosExitosamente = 0;

  try {
    const { rows: mensajes } = await pool.query(
      `SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= NOW()
       ORDER BY fecha_envio ASC
       LIMIT 20`
    );

    if (mensajes.length === 0) {
      console.log("📭 [Worker] No había mensajes pendientes para enviar.");
      return;
    }

    for (const mensaje of mensajes) {
      try {
        const { rows: tenantRows } = await pool.query(
          'SELECT twilio_number FROM tenants WHERE id = $1',
          [mensaje.tenant_id]
        );

        const tenant = tenantRows[0];

        if (!tenant || !tenant.twilio_number) {
          console.warn('⚠️ [Worker] No se encontró número de Twilio para tenant:', mensaje.tenant_id);
          continue;
        }

        await client.messages.create({
          from: `whatsapp:${tenant.twilio_number}`,
          to: `whatsapp:${mensaje.contacto}`,
          body: mensaje.contenido,
        });

        await pool.query(
          `UPDATE mensajes_programados SET enviado = true WHERE id = $1`,
          [mensaje.id]
        );

        enviadosExitosamente++;
      } catch (error) {
        console.error(`❌ [Worker] Error enviando mensaje a ${mensaje.contacto}:`, error);
      }
    }

    if (enviadosExitosamente > 0) {
      console.log(`📬 [Worker] ${enviadosExitosamente} mensajes enviados exitosamente ✅`);
    } else {
      console.log("📭 [Worker] Ningún mensaje pudo ser enviado.");
    }
  } catch (error) {
    console.error('❌ [Worker] Error general en sendScheduledMessages:', error);
  }
}
