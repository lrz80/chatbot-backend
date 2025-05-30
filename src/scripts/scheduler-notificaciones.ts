import pool from '../lib/db';
import { sendEmailSendgrid } from '../lib/senders/email-sendgrid';
import { sendSMS } from '../lib/senders/sms';

async function verificarNotificaciones() {
  console.log("🚨 Verificando límites de uso...");

  const canales = ['whatsapp', 'meta', 'followup', 'voz', 'sms', 'email'];

  for (const canal of canales) {
    // 🔥 Obtenemos uso_mensual unido con fecha de membresia_inicio del tenant
    const { rows: tenants } = await pool.query(`
      SELECT u.tenant_id, u.usados, u.limite, 
             t.name AS tenant_name, t.telefono_negocio, t.email_negocio,
             u2.email AS user_email, u2.telefono AS user_phone,
             t.membresia_inicio
      FROM uso_mensual u
      JOIN tenants t ON u.tenant_id = t.id
      LEFT JOIN users u2 ON u2.tenant_id = u.tenant_id
      WHERE u.canal = $1 AND u.limite IS NOT NULL
    `, [canal]);

    for (const tenant of tenants) {
      const fechaInicio = tenant.membresia_inicio ? new Date(tenant.membresia_inicio) : null;
      if (!fechaInicio) {
        console.warn(`⛔️ Tenant ${tenant.tenant_id} no tiene membresia_inicio`);
        continue;
      }

      // 🔎 Calculamos usados desde membresia_inicio (sumando de uso_mensual)
      const usadosQuery = await pool.query(`
        SELECT COALESCE(SUM(usados), 0) as total_usados, MAX(limite) as limite
        FROM uso_mensual
        WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
      `, [tenant.tenant_id, canal, fechaInicio.toISOString().substring(0, 10)]);

      const usados = parseInt(usadosQuery.rows[0]?.total_usados || '0', 10);
      const limite = parseInt(usadosQuery.rows[0]?.limite || '0', 10);
      const porcentaje = limite ? (usados / limite) * 100 : 0;

      if (porcentaje < 80) {
        console.log(`🔕 ${tenant.tenant_name} tiene un consumo bajo (${porcentaje.toFixed(1)}%), no se enviará notificación.`);
        continue;
      }

      const asunto = `🚨 Alerta: Uso en ${canal.toUpperCase()} (${porcentaje.toFixed(1)}%)`;
      const mensajeTexto = `
        Hola ${tenant.tenant_name},

        Has usado ${usados} de ${limite} en ${canal.toUpperCase()} desde tu membresía activa.
        ${porcentaje >= 100 ? '🚫 Has superado tu límite mensual.' : '⚠️ Estás alcanzando tu límite mensual (80%+).'}

        Te recomendamos aumentar el límite para evitar interrupciones.

        Atentamente,
        Aamy.ai`;

      const correos = [tenant.email_negocio, tenant.user_email].filter((e) => typeof e === 'string');
      if (correos.length > 0) {
        const contactos = correos.map(email => ({ email, nombre: tenant.tenant_name }));
        await sendEmailSendgrid(
          mensajeTexto,
          contactos,
          'Aamy.ai',
          String(tenant.tenant_id),
          0,
          undefined,
          undefined,
          'https://aamy.ai/avatar-amy.png',
          asunto,
          asunto
        );
        console.log(`📧 Emails enviados a: ${correos.join(', ')}`);
      }

      const telefonos = [tenant.telefono_negocio, tenant.user_phone].filter((t) => typeof t === 'string');
      for (const telefono of telefonos) {
        await sendSMS(
          mensajeTexto,
          [telefono],
          telefono,
          String(tenant.tenant_id),
          0
        );
        console.log(`📲 SMS enviado a: ${telefono}`);
      }
    }
  }

  console.log("✅ Verificación de notificaciones completada.");
}

// 🕒 Ejecutar cada 5 minutos
setInterval(() => {
  verificarNotificaciones();
}, 5 * 60 * 1000);

console.log("⏰ Scheduler de notificaciones corriendo...");

export { verificarNotificaciones };
