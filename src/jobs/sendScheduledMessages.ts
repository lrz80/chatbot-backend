import pool from '../lib/db';
import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

// 📩 Enviar mensajes programados pendientes
export async function sendScheduledMessages() {
  let enviadosExitosamente = 0;
  try {
    const now = new Date();

    const result = await pool.query(
      `SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= NOW()
       ORDER BY fecha_envio ASC
       LIMIT 20`
    );

    const mensajes = result.rows;

    if (mensajes.length === 0) {
      console.log("📭 Job de Seguimiento: No había mensajes pendientes");
      return;
    }

    for (const mensaje of mensajes) {
      try {
        const tenantRes = await pool.query(
          'SELECT twilio_number FROM tenants WHERE id = $1',
          [mensaje.tenant_id]
        );
        const tenant = tenantRes.rows[0];

        if (!tenant || !tenant.twilio_number) {
          console.warn('⚠️ No se encontró número de Twilio para tenant:', mensaje.tenant_id);
          continue;
        }

        // Enviar mensaje
        await client.messages.create({
          from: `whatsapp:${tenant.twilio_number}`,
          to: `whatsapp:${mensaje.contacto}`,
          body: mensaje.contenido,
        });

        // Marcar como enviado
        await pool.query(
          `UPDATE mensajes_programados SET enviado = true WHERE id = $1`,
          [mensaje.id]
        );

        enviadosExitosamente++;
      } catch (error) {
        console.error(`❌ Error enviando mensaje a ${mensaje.contacto}:`, error);
      }
    }

    if (enviadosExitosamente > 0) {
      console.log(`📬 Job de Seguimiento: ${enviadosExitosamente} mensajes enviados exitosamente ✅`);
    } else {
      console.log("📭 Job de Seguimiento: Ningún mensaje pudo ser enviado");
    }
  } catch (error) {
    console.error('❌ Error general en sendScheduledMessages:', error);
  }
}
