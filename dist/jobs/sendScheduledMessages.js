"use strict";
// 📁 src/jobs/sendScheduledMessages.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendScheduledMessages = sendScheduledMessages;
const db_1 = __importDefault(require("../lib/db"));
const twilio_1 = __importDefault(require("twilio"));
// 📩 Enviar mensajes programados pendientes
async function sendScheduledMessages(accountSidManual, authTokenManual) {
    const accountSid = accountSidManual || process.env.TWILIO_ACCOUNT_SID;
    const authToken = authTokenManual || process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        console.error('[Worker] ❌ No se pudo cargar TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN.');
        return;
    }
    const client = (0, twilio_1.default)(accountSid, authToken);
    let enviadosExitosamente = 0;
    try {
        const { rows: mensajes } = await db_1.default.query(`SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= NOW()
       ORDER BY fecha_envio ASC
       LIMIT 20`);
        if (mensajes.length === 0) {
            console.log('[Worker] 📭 No hay mensajes pendientes para enviar.');
            return;
        }
        for (const mensaje of mensajes) {
            try {
                // ✅ Solo enviar si canal es WhatsApp
                if (mensaje.canal !== 'whatsapp') {
                    console.warn(`❌ Canal no compatible para seguimiento automático: ${mensaje.canal}`);
                    continue;
                }
                // ✅ Validar número internacional
                if (!mensaje.contacto || !mensaje.contacto.startsWith('+')) {
                    console.warn(`❌ Número inválido para Twilio: ${mensaje.contacto}`);
                    continue;
                }
                const { rows: tenantRows } = await db_1.default.query('SELECT twilio_number FROM tenants WHERE id = $1', [mensaje.tenant_id]);
                const tenant = tenantRows[0];
                if (!tenant || !tenant.twilio_number) {
                    console.warn('[Worker] ⚠️ No se encontró número de Twilio para tenant:', mensaje.tenant_id);
                    continue;
                }
                console.log(`[Worker] ➡️ Enviando mensaje a ${mensaje.contacto}...`);
                await client.messages.create({
                    from: `whatsapp:${tenant.twilio_number}`,
                    to: `whatsapp:${mensaje.contacto}`,
                    body: mensaje.contenido,
                });
                await db_1.default.query(`UPDATE mensajes_programados SET enviado = true WHERE id = $1`, [mensaje.id]);
                await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
           VALUES ($1, 'bot', $2, NOW(), 'whatsapp', $3)`, [mensaje.tenant_id, mensaje.contenido, mensaje.contacto]);
                console.log(`[Worker] ✅ Mensaje enviado correctamente a ${mensaje.contacto}`);
                enviadosExitosamente++;
            }
            catch (error) {
                console.error(`[Worker] ❌ Error enviando a ${mensaje.contacto}:`, error);
            }
        }
        if (enviadosExitosamente > 0) {
            console.log(`[Worker] 📬 Job de Seguimiento: ${enviadosExitosamente} mensajes enviados exitosamente ✅`);
        }
        else {
            console.log("[Worker] 📭 No se logró enviar ningún mensaje.");
        }
    }
    catch (error) {
        console.error('[Worker] ❌ Error general en sendScheduledMessages:', error);
    }
}
