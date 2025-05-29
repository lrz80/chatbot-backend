import pool from '../lib/db';
import { sendEmailSendgrid } from '../lib/senders/email-sendgrid';
import { sendSMS } from '../lib/senders/sms';

async function verificarNotificaciones() {
  console.log("🚨 Verificando límites de uso...");

  const mesActual = new Date().toISOString().substring(0, 7) + '-01';
  const canales = ['whatsapp', 'meta', 'followup', 'voz', 'sms', 'email'];

  for (const canal of canales) {
    const { rows: tenants } = await pool.query(`
      SELECT u.tenant_id, u.usados, u.limite, 
             t.name AS tenant_name, t.telefono_negocio, t.email_negocio,
             u2.email AS user_email, u2.telefono AS user_phone
      FROM uso_mensual u
      JOIN tenants t ON u.tenant_id = t.id
      LEFT JOIN users u2 ON u2.tenant_id = u.tenant_id
      WHERE u.canal = $1 AND u.mes = $2 AND u.limite IS NOT NULL
    `, [canal, mesActual]);

    for (const tenant of tenants) {
      const porcentaje = (tenant.usados / tenant.limite) * 100;
      const asunto = `🚨 Alerta: Uso en ${canal.toUpperCase()} (${porcentaje.toFixed(1)}%)`;
      const mensajeTexto = `
        Hola ${tenant.tenant_name},

        Has usado ${tenant.usados} de ${tenant.limite} en ${canal.toUpperCase()} este mes.
        ${porcentaje >= 100 ? '🚫 Has superado tu límite mensual.' : '⚠️ Estás alcanzando tu límite mensual.'}

        Te recomendamos aumentar el límite para evitar interrupciones.

        Atentamente,
        Aamy.ai`;

      // 📧 Correos: email_negocio + user_email
      const correos = [tenant.email_negocio, tenant.user_email].filter((e) => typeof e === 'string');
      if (correos.length > 0) {
        const contactos = correos.map(email => ({ email, nombre: tenant.tenant_name }));
        await sendEmailSendgrid(
          mensajeTexto,
          contactos,
          'Aamy.ai',                      // ✅ Nombre remitente
          String(tenant.tenant_id),       // ✅ Convertimos a string
          0,                              // 📨 No es campaña, pero usamos 0 como placeholder
          undefined,                      // imagenUrl
          undefined,                      // linkUrl
          'https://aamy.ai/avatar-amy.png', // ✅ Logo Aamy.ai
          asunto,                         // ✅ Asunto
          asunto                          // ✅ Título visual
        );
        console.log(`📧 Emails enviados a: ${correos.join(', ')}`);
      }

      // 📲 SMS: telefono_negocio + user_phone (sin logo)
      const telefonos = [tenant.telefono_negocio, tenant.user_phone].filter((t) => typeof t === 'string');
      for (const telefono of telefonos) {
        await sendSMS(
          mensajeTexto,
          [telefono],
          telefono,
          String(tenant.tenant_id),      // ✅ Convertimos a string
          0                              // 📨 Placeholder para campaignId
        );
        console.log(`📲 SMS enviado a: ${telefono}`);
      }
    }
  }

  console.log("✅ Verificación de notificaciones completada.");
}

// 🕒 Ejecutar cada hora (puedes ajustar el intervalo)
setInterval(() => {
  verificarNotificaciones();
}, 60 * 1000);

console.log("⏰ Scheduler de notificaciones corriendo...");

export { verificarNotificaciones };
