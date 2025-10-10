import pool from '../lib/db';
import { sendEmailSendgrid } from '../lib/senders/email-sendgrid';
import { sendSMSNotificacion } from '../lib/senders/smsNotificacion';
import express from 'express';

function toISODate(d: Date) {
  return d.toISOString().substring(0, 10);
}

async function verificarNotificaciones() {
  console.log("🚨 Verificando límites de uso...");

  // 1) Desactivar membresías vencidas
  await pool.query(`
    UPDATE tenants
    SET membresia_activa = false
    WHERE membresia_vigencia < NOW() AND membresia_activa = true
  `);
  console.log("🔄 Membresías vencidas actualizadas.");

  const canales: Array<'whatsapp' | 'meta' | 'followup' | 'voz' | 'sms' | 'email'> = ['whatsapp', 'meta', 'followup', 'voz', 'sms', 'email'];

  for (const canal of canales) {
    // ⚠️ Podría haber múltiples usuarios por tenant → filas duplicadas.
    // Usaremos un Set para no procesar dos veces el mismo tenant en este canal.
    const procesados = new Set<string>();

    const { rows: tenants } = await pool.query(`
      SELECT 
        u.tenant_id, 
        u.usados, 
        u.limite, 
        t.name              AS tenant_name, 
        t.telefono_negocio, 
        t.email_negocio,
        u2.email            AS user_email, 
        u2.telefono         AS user_phone,
        t.membresia_inicio
      FROM uso_mensual u
      JOIN tenants t   ON u.tenant_id = t.id
      LEFT JOIN users u2 ON u2.tenant_id = u.tenant_id
      WHERE u.canal = $1 AND u.limite IS NOT NULL
    `, [canal]);

    for (const tenant of tenants) {
      const tid = String(tenant.tenant_id);

      // Evita duplicados por múltiples usuarios del mismo tenant
      if (procesados.has(tid)) continue;
      procesados.add(tid);

      const fechaInicio: Date | null = tenant.membresia_inicio ? new Date(tenant.membresia_inicio) : null;
      if (!fechaInicio || Number.isNaN(fechaInicio.getTime())) {
        console.warn(`⛔️ Tenant ${tid} no tiene membresia_inicio válida`);
        continue;
      }

      // 2) Recalcular usados/limite del ciclo vigente
      const usadosQuery = await pool.query(`
        SELECT 
          COALESCE(SUM(usados), 0)             AS total_usados,   -- Para VOZ esto suele venir en segundos
          MAX(limite)                          AS limite,         -- En VOZ suelen ser minutos/mes
          BOOL_OR(notificado_80)               AS notificado_80, 
          BOOL_OR(notificado_100)              AS notificado_100
        FROM uso_mensual
        WHERE tenant_id = $1 
          AND canal = $2 
          AND mes >= $3
      `, [tid, canal, toISODate(fechaInicio)]);

      const usadosRaw = parseInt(usadosQuery.rows[0]?.total_usados || '0', 10);
      let limite = parseInt(usadosQuery.rows[0]?.limite || '0', 10);
      const notificado_80  = Boolean(usadosQuery.rows[0]?.notificado_80);
      const notificado_100 = Boolean(usadosQuery.rows[0]?.notificado_100);

      // 3) Sumar créditos activos (add-ons)
      const creditosQuery = await pool.query(`
        SELECT COALESCE(SUM(cantidad), 0) AS creditos
        FROM creditos_comprados
        WHERE tenant_id = $1 
          AND canal = $2 
          AND fecha_compra <= NOW() 
          AND fecha_vencimiento >= NOW()
      `, [tid, canal]);

      const creditos = parseInt(creditosQuery.rows[0]?.creditos || '0', 10);
      limite += creditos;

      // 4) Normalizar unidades
      // - Para VOZ: "usados" vienen en segundos -> convertir a minutos redondeando hacia arriba.
      // - Para el resto de canales: se asume que "usados" y "limite" ya están en la misma unidad (mensajes/créditos).
      const usadosNormalizados = (canal === 'voz')
        ? Math.ceil(usadosRaw / 60) // seg → min
        : usadosRaw;

      // Evitar división por cero y casos ilógicos de límite nulo
      const limiteSeguro = Math.max(1, limite); 
      const porcentaje = (usadosNormalizados / limiteSeguro) * 100;

      if (porcentaje < 80) {
        console.log(`🔕 ${tenant.tenant_name} (${canal}) consumo bajo (${porcentaje.toFixed(1)}%), no se notificará.`);
        continue;
      }

      // No repetir notificaciones
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

Has usado ${usadosNormalizados} de ${limiteSeguro} en ${canal.toUpperCase()} desde tu membresía activa.
${porcentaje >= 100 ? '🚫 Has superado tu límite mensual.' : '⚠️ Estás alcanzando tu límite mensual (80%+).'}

Te recomendamos aumentar el límite para evitar interrupciones.

Atentamente,
Aamy.ai`.trim();

      // 5) Email (si hay al menos un correo de usuario)
      const correo = typeof tenant.user_email === 'string' && tenant.user_email.includes('@')
        ? tenant.user_email
        : null;

      if (correo) {
        const contactos = [{ email: correo, nombre: tenant.tenant_name }];
        await sendEmailSendgrid(
          mensajeTexto,
          contactos,
          'Aamy.ai',
          String(tid),
          0,
          undefined,
          undefined,
          'https://aamy.ai/avatar-amy.png',
          asunto,     // asunto para SendGrid
          asunto      // título visual
        );
        console.log(`📧 Email enviado a: ${correo}`);
      } else {
        console.warn(`❌ No se encontró user_email válido para ${tenant.tenant_name}`);
      }

      // 6) SMS (dedupe y validación básica)
      const telefonos = [tenant.telefono_negocio, tenant.user_phone]
        .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0);

      const enviadosSMS = new Set<string>();
      for (const tel of telefonos) {
        if (enviadosSMS.has(tel)) continue;
        enviadosSMS.add(tel);
        await sendSMSNotificacion(mensajeTexto, [tel]);
        console.log(`📲 SMS notificación enviado a: ${tel}`);
      }

      // 7) Marcar notificado
      const notificacionField = (porcentaje >= 100) ? 'notificado_100' : 'notificado_80';
      await pool.query(`
        UPDATE uso_mensual
        SET ${notificacionField} = TRUE
        WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
      `, [tid, canal, toISODate(fechaInicio)]);
    }
  }

  console.log("✅ Verificación de notificaciones completada.");
}

// Intervalo cada 5 minutos
setInterval(() => {
  verificarNotificaciones().catch(err => {
    console.error("❌ Error en verificarNotificaciones:", err);
  });
}, 5 * 60 * 1000);

console.log("⏰ Scheduler de notificaciones corriendo...");

export { verificarNotificaciones };

// Mini servidor para healthcheck
const app = express();
const PORT = process.env.PORT || 3002;

app.get('/', (_req, res) => {
  res.send('🟢 Verificador de notificaciones activo');
});

app.listen(PORT, () => {
  console.log(`🚀 Verificador corriendo en http://localhost:${PORT}`);
});
