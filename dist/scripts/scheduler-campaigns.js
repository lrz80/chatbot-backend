"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
if (process.env.NODE_ENV !== 'production') {
    dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env.local') });
}
const db_1 = __importDefault(require("../lib/db"));
const sms_1 = require("../lib/senders/sms");
const whatsapp_1 = require("../lib/senders/whatsapp");
const email_sendgrid_1 = require("../lib/senders/email-sendgrid");
const usoMensual_1 = require("../lib/usoMensual");
async function ejecutarCampañasProgramadas() {
    const ahora = new Date().toISOString();
    const campañas = await db_1.default.query(`SELECT *
     FROM campanas
     WHERE enviada = false
       AND programada_para <= $1
     ORDER BY programada_para ASC
     LIMIT 10`, [ahora]);
    for (const c of campañas.rows) {
        try {
            const contactosParsed = JSON.parse(c.destinatarios || "[]");
            const tenantId = c.tenant_id;
            const campaignId = c.id;
            const canal = c.canal;
            const { usados, limite } = await (0, usoMensual_1.obtenerUsoActual)(tenantId, canal);
            if (usados + contactosParsed.length > limite) {
                console.warn(`⛔️ Límite mensual alcanzado para ${canal.toUpperCase()} en tenant ${tenantId}`);
                continue;
            }
            let enviados = 0;
            if (canal === "sms") {
                const tenantRes = await db_1.default.query("SELECT twilio_sms_number FROM tenants WHERE id = $1", [tenantId]);
                const from = tenantRes.rows[0]?.twilio_sms_number;
                if (!from) {
                    console.warn(`⚠️ No hay número Twilio SMS para tenant ${tenantId}`);
                    continue;
                }
                // ✅ Solo se contabilizan los SMS válidos enviados
                enviados = await (0, sms_1.sendSMS)(c.contenido, contactosParsed, from, tenantId, campaignId);
            }
            if (canal === "whatsapp") {
                const tenantRes = await db_1.default.query("SELECT twilio_number FROM tenants WHERE id = $1", [tenantId]);
                const from = tenantRes.rows[0]?.twilio_number;
                if (!from)
                    continue;
                const { template_sid, template_vars } = c;
                if (!template_sid)
                    continue;
                let vars = {};
                try {
                    vars = typeof template_vars === "string" ? JSON.parse(template_vars) : template_vars;
                }
                catch { }
                const contactos = contactosParsed.map((tel) => ({ telefono: tel }));
                await (0, whatsapp_1.sendWhatsApp)(template_sid, contactos, `whatsapp:${from}`, tenantId, campaignId, vars);
                enviados = contactos.length;
            }
            if (canal === "email") {
                const tenantRes = await db_1.default.query("SELECT name, logo_url FROM tenants WHERE id = $1", [tenantId]);
                const nombreNegocio = tenantRes.rows[0]?.name || "Tu negocio";
                const logoUrl = tenantRes.rows[0]?.logo_url;
                const contactosRes = await db_1.default.query(`SELECT email, nombre FROM contactos
           WHERE tenant_id = $1 AND email = ANY($2)`, [tenantId, contactosParsed]);
                const contactos = contactosRes.rows.map((c) => ({
                    email: c.email,
                    nombre: c.nombre || "amigo/a",
                }));
                await (0, email_sendgrid_1.sendEmailSendgrid)(c.contenido, contactos, nombreNegocio, tenantId, campaignId, c.imagen_url || undefined, c.link_url || undefined, logoUrl, c.asunto || "📣 Nueva campaña de tu negocio", c.titulo_visual || "");
                enviados = contactos.length;
            }
            // 🔍 Obtiene membresia_inicio
            const { rows: rowsTenant } = await db_1.default.query(`SELECT membresia_inicio FROM tenants WHERE id = $1`, [tenantId]);
            const membresiaInicio = rowsTenant[0]?.membresia_inicio;
            if (!membresiaInicio) {
                console.error('❌ No se encontró membresia_inicio para el tenant:', tenantId);
                continue;
            }
            // 🔄 Calcula ciclo mensual
            const inicio = new Date(membresiaInicio);
            const ahora = new Date();
            const diffInMonths = Math.floor((ahora.getFullYear() - inicio.getFullYear()) * 12 + (ahora.getMonth() - inicio.getMonth()));
            const cicloInicio = new Date(inicio);
            cicloInicio.setMonth(inicio.getMonth() + diffInMonths);
            const cicloMes = cicloInicio.toISOString().split('T')[0]; // YYYY-MM-DD
            await db_1.default.query(`INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (tenant_id, canal, mes) DO UPDATE
        SET usados = uso_mensual.usados + EXCLUDED.usados`, [tenantId, canal, cicloMes, enviados]);
            await db_1.default.query("UPDATE campanas SET enviada = true WHERE id = $1", [campaignId]);
            console.log(`✅ Campaña #${campaignId} enviada (${canal} → ${enviados} contactos)`);
        }
        catch (err) {
            console.error(`❌ Error procesando campaña #${c.id}:`, err);
        }
    }
}
setInterval(() => {
    ejecutarCampañasProgramadas();
}, 60 * 1000);
console.log("🕒 Scheduler de campañas corriendo cada 1 minuto...");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.get('/', (_req, res) => {
    res.send('🟢 Campaign scheduler is running...');
});
app.listen(PORT, () => {
    console.log(`🚀 Scheduler activo en http://localhost:${PORT}`);
});
