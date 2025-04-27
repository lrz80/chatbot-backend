// 📁 src/jobs/sendScheduledMessages.ts

import pool from '../lib/db';

export async function sendScheduledMessages() {
  const { default: twilio } = await import('twilio'); // ⬅️ dinámico

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('❌ TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN no definidos.');
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
      console.log("📭 No hay mensajes programados pendientes");
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
          console.warn('⚠️ No se encontró número de Twilio para tenant:', mensaje.tenant_id);
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
        console.error(`❌ Error enviando a ${mensaje.contacto}:`, error);
      }
    }

    if (enviadosExitosamente > 0) {
      console.log(`📬 ${enviadosExitosamente} mensajes enviados correctamente ✅`);
    } else {
      console.log("📭 Ningún mensaje enviado");
    }
  } catch (error) {
    console.error('❌ Error general en sendScheduledMessages:', error);
  }
}
