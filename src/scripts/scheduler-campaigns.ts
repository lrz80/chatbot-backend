// src/scripts/scheduler-campaigns.ts
import dotenv from 'dotenv';
import path from 'path';
import express from 'express';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
}

import pool from "../lib/db";
import { sendSMS } from "../lib/senders/sms";
import { sendWhatsApp } from "../lib/senders/whatsapp";
import { sendEmailSendgrid } from "../lib/senders/email-sendgrid";

// ====== Base por canal (se suma a créditos vigentes) ======
const CANAL_BASE: Record<string, number> = {
  sms: 500,
  whatsapp: 300,
  email: 1000,
};

// ====== Helper: cupo dinámico por canal ======
async function getCapacidadCanal(tenantId: string, canal: string) {
  const base = CANAL_BASE[canal] ?? 0;

  // usados del mes (contador real) desde campaign_usage
  const { rows: urows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS usados
    FROM campaign_usage
    WHERE tenant_id = $1
      AND canal = $2
      AND fecha_envio >= date_trunc('month', CURRENT_DATE)
    `,
    [tenantId, canal]
  );
  const usados = urows[0]?.usados ?? 0;

  // créditos vigentes hasta la MISMA hora/min/seg del vencimiento
  const { rows: crows } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS extra_vigente
    FROM creditos_comprados
    WHERE tenant_id = $1
      AND canal = $2
      AND NOW() <= fecha_vencimiento
    `,
    [tenantId, canal]
  );
  const extraVigente = crows[0]?.extra_vigente ?? 0;

  const limite = base + extraVigente;
  const restante = Math.max(limite - usados, 0);

  return { base, extraVigente, usados, limite, restante };
}

async function ejecutarCampañasProgramadas() {
  const ahoraISO = new Date().toISOString();

  const campañas = await pool.query(
    `SELECT *
     FROM campanas
     WHERE enviada = false
       AND programada_para <= $1
     ORDER BY programada_para ASC
     LIMIT 10`,
    [ahoraISO]
  );

  for (const c of campañas.rows) {
    try {
      const contactosParsed: string[] = JSON.parse(c.destinatarios || "[]");
      const tenantId = c.tenant_id as string;
      const campaignId = Number(c.id);
      const canal = c.canal as string;

      // 🔐 Límite dinámico por canal
      const cap = await getCapacidadCanal(tenantId, canal);

      if (cap.restante <= 0) {
        console.warn(`⛔️ Límite mensual alcanzado para ${canal.toUpperCase()} en tenant ${tenantId} (limite=${cap.limite}, usados=${cap.usados})`);
        // Marcamos enviada=false para reintentar cuando haya créditos nuevos
        // (si prefieres marcar como "pausada", agrega un estado adicional en la tabla)
        continue;
      }

      // ⚡️ Variante PARCIAL: cortar a lo disponible
      let destinatarios = contactosParsed;
      let saltados = 0;
      if (destinatarios.length > cap.restante) {
        saltados = destinatarios.length - cap.restante;
        destinatarios = destinatarios.slice(0, cap.restante);
        console.warn(`⚠️ Campaña #${campaignId}: solicitó ${contactosParsed.length}, se enviarán ${destinatarios.length}. Saltados: ${saltados} (limite=${cap.limite}, usados=${cap.usados}).`);
      }

      if (destinatarios.length === 0) {
        console.warn(`⚠️ Campaña #${campaignId}: 0 destinatarios tras aplicar tope.`);
        continue;
      }

      let enviados = 0;

      if (canal === "sms") {
        const tenantRes = await pool.query(
          "SELECT twilio_sms_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_sms_number;
        if (!from) {
          console.warn(`⚠️ No hay número Twilio SMS para tenant ${tenantId}`);
          continue;
        }

        // ✅ Solo se contabilizan los SMS válidos enviados
        enviados = await sendSMS(c.contenido, destinatarios, from, tenantId, campaignId);
      }

      if (canal === "whatsapp") {
        const tenantRes = await pool.query(
          "SELECT twilio_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_number;
        if (!from) {
          console.warn(`⚠️ No hay número Twilio WhatsApp para tenant ${tenantId}`);
          continue;
        }

        const { template_sid, template_vars } = c;
        if (!template_sid) {
          console.warn(`⚠️ Falta template_sid para WhatsApp en campaña #${campaignId}`);
          continue;
        }

        let vars = {};
        try {
          vars = typeof template_vars === "string" ? JSON.parse(template_vars) : (template_vars || {});
        } catch { /* ignore */ }

        const contactos = destinatarios.map((tel: string) => ({ telefono: tel }));
        await sendWhatsApp(template_sid, contactos, `whatsapp:${from}`, tenantId, campaignId, vars);

        enviados = contactos.length;
      }

      if (canal === "email") {
        const tenantRes = await pool.query(
          "SELECT name, logo_url FROM tenants WHERE id = $1",
          [tenantId]
        );
        const nombreNegocio = tenantRes.rows[0]?.name || "Tu negocio";
        const logoUrl = tenantRes.rows[0]?.logo_url;

        // En este flujo asumimos que `destinatarios` son emails concretos
        const contactosRes = await pool.query(
          `SELECT email, nombre FROM contactos
           WHERE tenant_id = $1 AND email = ANY($2)`,
          [tenantId, destinatarios]
        );

        const contactos = contactosRes.rows.map((r: any) => ({
          email: r.email,
          nombre: r.nombre || "amigo/a",
        }));

        if (contactos.length === 0) {
          console.warn(`⚠️ Campaña #${campaignId}: los emails seleccionados no existen en contactos.`);
          continue;
        }

        await sendEmailSendgrid(
          c.contenido,
          contactos,
          nombreNegocio,
          tenantId,
          campaignId,
          c.imagen_url || undefined,
          c.link_url || undefined,
          logoUrl,
          c.asunto || "📣 Nueva campaña de tu negocio",
          c.titulo_visual || ""
        );

        enviados = contactos.length;
      }

      // Si no se envió nada, no registres uso ni marques enviada
      if (!enviados || enviados <= 0) {
        console.warn(`⚠️ Campaña #${campaignId}: 0 enviados tras intentar despacho.`);
        continue;
      }

      // 🧮 Registra uso real del mes
      await pool.query(
        `INSERT INTO campaign_usage (tenant_id, canal, cantidad, fecha_envio)
         VALUES ($1, $2, $3, NOW())`,
        [tenantId, canal, enviados]
      );

      // 🔍 membresía_inicio para tu métrica en uso_mensual (informativo)
      const { rows: rowsTenant } = await pool.query(
        `SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenantId]
      );
      const membresiaInicio = rowsTenant[0]?.membresia_inicio;
      if (membresiaInicio) {
        const inicio = new Date(membresiaInicio);
        const now = new Date();
        const diffInMonths = Math.floor(
          (now.getFullYear() - inicio.getFullYear()) * 12 + (now.getMonth() - inicio.getMonth())
        );
        const cicloInicio = new Date(inicio);
        cicloInicio.setMonth(inicio.getMonth() + diffInMonths);
        const cicloMes = cicloInicio.toISOString().split('T')[0]; // YYYY-MM-DD

        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, canal, mes) DO UPDATE
           SET usados = uso_mensual.usados + EXCLUDED.usados,
               limite = EXCLUDED.limite`,
          [tenantId, canal, cicloMes, enviados, cap.limite]
        );
      } else {
        console.error('❌ No se encontró membresia_inicio para el tenant:', tenantId);
      }

      // Marcar como enviada: ya se procesó (parcial o total)
      await pool.query("UPDATE campanas SET enviada = true WHERE id = $1", [campaignId]);

      const detalleParcial = saltados > 0 ? ` | enviados ${enviados}, saltados ${saltados}` : ` | enviados ${enviados}`;
      console.log(`✅ Campaña #${campaignId} procesada (${canal}${detalleParcial})`);

    } catch (err) {
      console.error(`❌ Error procesando campaña #${c.id}:`, err);
    }
  }
}

setInterval(() => {
  ejecutarCampañasProgramadas();
}, 60 * 1000);

console.log("🕒 Scheduler de campañas corriendo cada 1 minuto...");
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/', (_req, res) => {
  res.send('🟢 Campaign scheduler is running...');
});

app.listen(PORT, () => {
  console.log(`🚀 Scheduler activo en http://localhost:${PORT}`);
});
