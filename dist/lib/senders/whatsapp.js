"use strict";
// src/senders/whatsapp.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsApp = sendWhatsApp;
exports.enviarWhatsApp = enviarWhatsApp;
const twilio_1 = __importDefault(require("twilio"));
const db_1 = __importDefault(require("../db"));
const client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
// Función para normalizar número al formato internacional
function normalizarNumero(numero) {
    const limpio = numero.replace(/\D/g, "");
    if (limpio.length === 10)
        return `+1${limpio}`;
    if (limpio.length === 11 && limpio.startsWith("1"))
        return `+${limpio}`;
    if (numero.startsWith("+"))
        return numero;
    return "";
}
/**
 * Envía un mensaje de WhatsApp usando plantilla de contenido de Twilio
 */
async function sendWhatsApp(templateSid, contactos, fromNumber, tenantId, campaignId, templateVars) {
    if (!Array.isArray(contactos) || contactos.length === 0)
        return;
    for (const contacto of contactos) {
        const telefonoRaw = contacto?.telefono?.trim();
        const telefono = normalizarNumero(telefonoRaw || "");
        if (!telefono)
            continue;
        const to = `whatsapp:${telefono}`;
        console.log(`📤 Enviando plantilla ${templateSid} a ${to}`);
        try {
            const message = await client.messages.create({
                from: fromNumber,
                to,
                contentSid: templateSid,
                contentVariables: JSON.stringify(templateVars),
            });
            await db_1.default.query(`INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`, [tenantId, campaignId, message.sid, message.status, telefono, fromNumber]);
            console.log(`✅ WhatsApp enviado a ${telefono}`);
        }
        catch (err) {
            console.error(`❌ Error al enviar a ${telefono}: ${err.message}`);
            await db_1.default.query(`INSERT INTO whatsapp_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, null, 'failed', $3, $4, $5, $6, NOW())`, [
                tenantId,
                campaignId,
                telefono,
                fromNumber,
                err?.code || null,
                err?.message || "Error desconocido",
            ]);
        }
    }
}
/**
 * Envía un mensaje de WhatsApp de sesión (sin plantilla)
 */
async function enviarWhatsApp(telefono, mensaje, tenantId) {
    const fromNumber = await obtenerNumeroDeTenant(tenantId); // 👈 obtiene el número de envío real
    const numero = normalizarNumero(telefono);
    if (!numero || !fromNumber) {
        console.warn("❌ Número inválido o tenant sin número asignado");
        return;
    }
    const to = `whatsapp:${numero}`;
    try {
        const msg = await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to,
            body: mensaje,
        });
        console.log(`✅ Mensaje enviado a ${to}`);
        await db_1.default.query(`INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, timestamp
      ) VALUES ($1, $2, $3, $4, $5, NOW())`, [tenantId, msg.sid, msg.status, numero, fromNumber]);
    }
    catch (err) {
        console.error(`❌ Error enviando a ${to}: ${err.message}`);
        await db_1.default.query(`INSERT INTO whatsapp_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, null, 'failed', $2, $3, $4, $5, NOW())`, [tenantId, numero, fromNumber, err.code || null, err.message || "Error desconocido"]);
    }
}
/**
 * Busca el número de WhatsApp asignado al tenant
 */
async function obtenerNumeroDeTenant(tenantId) {
    const result = await db_1.default.query("SELECT twilio_number FROM tenants WHERE id = $1 LIMIT 1", [tenantId]);
    return result.rows[0]?.twilio_number || null;
}
