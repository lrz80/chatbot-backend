"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmailSendgrid = sendEmailSendgrid;
exports.sendEmailWithTemplate = sendEmailWithTemplate;
const mail_1 = __importDefault(require("@sendgrid/mail"));
const db_1 = __importDefault(require("../db"));
const email_html_1 = require("../../utils/email-html");
mail_1.default.setApiKey(process.env.SENDGRID_API_KEY);
/**
 * Envío clásico de campaña con HTML generado
 */
async function sendEmailSendgrid(contenido, contactos, nombreNegocio, tenantId, campaignId, imagenUrl, linkUrl, logoUrl, asunto, tituloVisual) {
    console.log("📤 Asunto dentro de sendEmailSendgrid:", asunto);
    console.log("🎯 Título visual:", tituloVisual);
    const envíos = [];
    for (const contacto of contactos) {
        const email = contacto.email?.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            continue;
        const html = (0, email_html_1.generarHTMLCorreo)(contenido, nombreNegocio, imagenUrl, linkUrl, logoUrl, email, tenantId, contacto.nombre || "", asunto, tituloVisual);
        const msg = {
            to: email,
            from: {
                name: nombreNegocio,
                email: "noreply@aamy.ai",
            },
            subject: asunto || "📣 Nueva campaña de tu negocio",
            html,
        };
        envíos.push(msg);
    }
    try {
        console.log("📤 Asunto final del email:", asunto);
        await mail_1.default.send(envíos, true);
        console.log(`✅ Emails enviados correctamente (${envíos.length})`);
        const inserts = envíos.map((e) => db_1.default.query(`INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, timestamp)
         VALUES ($1, $2, $3, 'sent', NOW())`, [tenantId, campaignId, e.to]));
        await Promise.all(inserts);
    }
    catch (error) {
        const errorBody = error?.response?.body;
        const msg = errorBody?.errors?.[0]?.message || error?.message || "Error desconocido";
        console.error("❌ Error al enviar por SendGrid:", msg);
        const inserts = envíos.map((e) => db_1.default.query(`INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, error_message, timestamp)
         VALUES ($1, $2, $3, 'failed', $4, NOW())`, [tenantId, campaignId, e.to, msg]));
        await Promise.all(inserts);
    }
}
/**
 * Envío con plantilla dinámica de SendGrid
 */
async function sendEmailWithTemplate(contactos, templateId, nombreNegocio, tenantId, campaignId) {
    const envíos = [];
    for (const contacto of contactos) {
        const email = contacto.email?.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            continue;
        const vars = {
            nombre: contacto.nombre || "amigo/a",
            ...(contacto.vars || {}),
        };
        envíos.push({
            to: {
                email,
            },
            from: {
                name: nombreNegocio,
                email: "noreply@aamy.ai",
            },
            templateId,
            dynamicTemplateData: vars,
        });
    }
    try {
        await mail_1.default.send(envíos, true);
        console.log(`✅ Emails con plantilla enviados (${envíos.length})`);
        const inserts = envíos.map((e) => db_1.default.query(`INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, timestamp)
         VALUES ($1, $2, $3, 'sent', NOW())`, [tenantId, campaignId, e.to.email]));
        await Promise.all(inserts);
    }
    catch (error) {
        const errorBody = error?.response?.body;
        const msg = errorBody?.errors?.[0]?.message || error?.message || "Error desconocido";
        console.error("❌ Error en plantilla SendGrid:", msg);
        const inserts = envíos.map((e) => db_1.default.query(`INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, error_message, timestamp)
         VALUES ($1, $2, $3, 'failed', $4, NOW())`, [tenantId, campaignId, e.to.email, msg]));
        await Promise.all(inserts);
    }
}
