import pool from "../lib/db";
import { sendSMS } from "../lib/senders/sms";
import { sendWhatsApp } from "../lib/senders/whatsapp";
import { sendEmail } from "../lib/senders/email";

async function ejecutarCampañasProgramadas() {
  const ahora = new Date().toISOString();

  const campañas = await pool.query(`
    SELECT *
    FROM campanas
    WHERE enviada = false
      AND programada_para <= $1
    ORDER BY programada_para ASC
    LIMIT 10
  `, [ahora]);

  for (const c of campañas.rows) {
    try {
      const contactosParsed: string[] = JSON.parse(c.destinatarios || "[]");
      const tenantId = c.tenant_id;
      const campaignId = c.id;

      if (c.canal === "sms") {
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

      if (c.canal === "whatsapp") {
        const tenantRes = await pool.query(
          "SELECT twilio_number FROM tenants WHERE id = $1",
          [tenantId]
        );
        const from = tenantRes.rows[0]?.twilio_number;
        if (!from) continue;

        const templateRes = await pool.query(
          "SELECT template_sid, template_vars FROM campanas WHERE id = $1",
          [campaignId]
        );
        const { template_sid, template_vars } = templateRes.rows[0];

        if (!template_sid) continue;

        let vars = {};
        try {
          vars = typeof template_vars === "string" ? JSON.parse(template_vars) : template_vars;
        } catch {}

        const contactos = contactosParsed.map((tel: string) => ({ telefono: tel }));
        await sendWhatsApp(template_sid, contactos, `whatsapp:${from}`, tenantId, campaignId, vars);
      }

      if (c.canal === "email") {
        const tenantRes = await pool.query(
          "SELECT name FROM tenants WHERE id = $1",
          [tenantId]
        );
        const nombreNegocio = tenantRes.rows[0]?.name || "Tu negocio";

        const contactos = contactosParsed.map((email: string) => ({ email }));
        await sendEmail(c.contenido, contactos, nombreNegocio, tenantId, campaignId);
      }

      await pool.query("UPDATE campanas SET enviada = true WHERE id = $1", [campaignId]);

      console.log(`✅ Campaña #${campaignId} enviada`);

    } catch (err) {
      console.error(`❌ Error procesando campaña #${c.id}:`, err);
    }
  }
}

// 🕒 Mantener corriendo para revisar cada minuto
setInterval(() => {
  ejecutarCampañasProgramadas();
}, 60000);

console.log("🕒 Scheduler de campañas corriendo cada minuto...");

export { ejecutarCampañasProgramadas };
