// src/scripts/scheduler-campaigns.ts

import pool from "../lib/db";
import { sendSMS } from "../lib/senders/sms";
import { sendWhatsApp } from "../lib/senders/whatsapp";
import { sendEmailSendgrid } from "../lib/senders/email-sendgrid";
import { obtenerUsoActual } from "../lib/usoMensual";

async function ejecutarCampañasProgramadas() {
  const ahora = new Date().toISOString();

  const campañas = await pool.query(
    `SELECT *
     FROM campanas
     WHERE enviada = false
       AND programada_para <= $1
     ORDER BY programada_para ASC
     LIMIT 10`,
    [ahora]
  );

  for (const c of campañas.rows) {
    try {
      const contactosParsed: string[] = JSON.parse(c.destinatarios || "[]");
      const tenantId = c.tenant_id;
      const campaignId = c.id;
      const canal = c.canal;

      const { usados, limite } = await obtenerUsoActual(tenantId, canal);
      if (usados + contactosParsed.length > limite) {
        console.warn(`⛔️ Límite mensual alcanzado para ${canal.toUpperCase()} en tenant ${tenantId}`);
        continue;
      }

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

        await sendSMS(c.contenido, contactosParsed, from, tenantId, campaignId);
      }

      if (canal === "whatsapp") {
        const tenantRes = await pool.query(
          "SELECT twilio_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_number;
        if (!from) continue;

        const { template_sid, template_vars } = c;
        if (!template_sid) continue;

        let vars = {};
        try {
          vars = typeof template_vars === "string" ? JSON.parse(template_vars) : template_vars;
        } catch {}

        const contactos = contactosParsed.map((tel: string) => ({ telefono: tel }));
        await sendWhatsApp(template_sid, contactos, `whatsapp:${from}`, tenantId, campaignId, vars);
      }

      if (canal === "email") {
        const tenantRes = await pool.query(
          "SELECT name FROM tenants WHERE id = $1",
          [tenantId]
        );
        const nombreNegocio = tenantRes.rows[0]?.name || "Tu negocio";

        const contactos = contactosParsed.map((email: string) => ({ email }));
        await sendEmailSendgrid(c.contenido, contactos, nombreNegocio, tenantId, campaignId);
      }

      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
         VALUES ($1, $2, date_trunc('month', CURRENT_DATE), $3, $4)
         ON CONFLICT (tenant_id, canal, mes) DO UPDATE
         SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenantId, canal, contactosParsed.length, canal === "sms" ? 500 : 1000]
      );

      await pool.query("UPDATE campanas SET enviada = true WHERE id = $1", [campaignId]);

      console.log(`✅ Campaña #${campaignId} enviada`);
    } catch (err) {
      console.error(`❌ Error procesando campaña #${c.id}:`, err);
    }
  }
}

setInterval(() => {
  ejecutarCampañasProgramadas();
}, 60000);

console.log("🕒 Scheduler de campañas corriendo cada minuto...");

export { ejecutarCampañasProgramadas };
