import pool from '../lib/db';
import { sendEmailSendgrid } from '../lib/senders/email-sendgrid';
import { sendSMSNotificacion } from '../lib/senders/smsNotificacion'; // 🔥 Importa la nueva función

async function verificarNotificaciones() {
  console.log("🚨 Verificando límites de uso...");

  await pool.query(`
    UPDATE tenants
    SET membresia_activa = false
    WHERE membresia_vigencia < NOW() AND membresia_activa = true
  `);
  console.log("🔄 Membresías vencidas actualizadas.");

  const canales = ['whatsapp', 'meta', 'followup', 'voz', 'sms', 'email'];

  for (const canal of canales) {
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

      const usadosQuery = await pool.query(`
        SELECT COALESCE(SUM(usados), 0) as total_usados, MAX(limite) as limite,
               bool_or(notificado_80) as notificado_80, bool_or(notificado_100) as notificado_100
        FROM uso_mensual
        WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
      `, [tenant.tenant_id, canal, fechaInicio.toISOString().substring(0, 10)]);

      const usados = parseInt(usadosQuery.rows[0]?.total_usados || '0', 10);
      let limite = parseInt(usadosQuery.rows[0]?.limite || '0', 10);
      const notificado_80 = usadosQuery.rows[0]?.notificado_80;
      const notificado_100 = usadosQuery.rows[0]?.notificado_100;

      const creditosQuery = await pool.query(`
        SELECT COALESCE(SUM(cantidad), 0) AS creditos
        FROM creditos_comprados
        WHERE tenant_id = $1 AND canal = $2 AND fecha_compra <= NOW() AND fecha_vencimiento >= NOW()
      `, [tenant.tenant_id, canal]);
      const creditos = parseInt(creditosQuery.rows[0]?.creditos || '0', 10);
      limite += creditos;

      const porcentaje = limite ? (usados / limite) * 100 : 0;

      if (porcentaje < 80) {
        console.log(`🔕 ${tenant.tenant_name} (${canal}) consumo bajo (${porcentaje.toFixed(1)}%), no se notificará.`);
        continue;
      }

      if (porcentaje >= 100 && notificado_100) {
        console.log(`🔕 ${tenant.tenant_name} (${canal}) ya notificado por 100%.`);
        continue;
      }
      if (porcentaje >= 80 && porcentaje < 100 && notificado_80) {
        console.log(`🔕 ${tenant.tenant_name} (${canal}) ya notificado por 80%.`);
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

      const correos = [tenant.email_negocio, tenant.user_email].filter(e => typeof e === 'string');
      if (correos.length > 0) {
        const contactos = correos.map(email => ({ email, nombre: tenant.tenant_name }));
        await sendEmailSendgrid(mensajeTexto, contactos, 'Aamy.ai', String(tenant.tenant_id), 0, undefined, undefined, 'https://aamy.ai/avatar-amy.png', asunto, asunto);
        console.log(`📧 Emails enviados a: ${correos.join(', ')}`);
      }

      const telefonos = [tenant.telefono_negocio, tenant.user_phone].filter(t => typeof t === 'string');
      for (const telefono of telefonos) {
        await sendSMSNotificacion(mensajeTexto, [telefono]); // 🔥 Usa la nueva función
        console.log(`📲 SMS notificación enviado a: ${telefono}`);
      }

      const notificacionField = porcentaje >= 100 ? 'notificado_100' : 'notificado_80';
      await pool.query(`
        UPDATE uso_mensual
        SET ${notificacionField} = TRUE
        WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
      `, [tenant.tenant_id, canal, fechaInicio.toISOString().substring(0, 10)]);
    }
  }

  console.log("✅ Verificación de notificaciones completada.");
}

setInterval(() => {
  verificarNotificaciones();
}, 5 * 60 * 1000);

console.log("⏰ Scheduler de notificaciones corriendo...");

export { verificarNotificaciones };
