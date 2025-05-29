"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSMS = sendSMS;
const twilio_1 = __importDefault(require("twilio"));
const db_1 = __importDefault(require("../db"));
const client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
// ✅ Normaliza al formato E.164
function normalizarNumero(numero) {
    const limpio = numero.trim();
    if (/^\+\d{10,15}$/.test(limpio))
        return limpio;
    const soloNumeros = limpio.replace(/\D/g, "");
    if (soloNumeros.length === 10)
        return `+1${soloNumeros}`;
    if (soloNumeros.length === 11 && soloNumeros.startsWith("1"))
        return `+${soloNumeros}`;
    if (soloNumeros.startsWith("00"))
        return `+${soloNumeros.slice(2)}`;
    return `+${soloNumeros}`; // fallback
}
const callbackBaseUrl = process.env.API_BASE_URL;
if (!callbackBaseUrl) {
    console.warn("⚠️ API_BASE_URL no está definida en el entorno.");
}
else {
    console.log("📤 Usando callback URL:", `${callbackBaseUrl}/api/webhook/sms-status`);
}
async function sendSMS(mensaje, destinatarios, fromNumber, tenantId, campaignId) {
    for (const rawTo of destinatarios) {
        const to = normalizarNumero(rawTo);
        if (!/^\+\d{10,15}$/.test(to)) {
            console.warn(`❌ Número inválido para SMS: ${rawTo}`);
            continue;
        }
        try {
            const message = await client.messages.create({
                body: mensaje,
                from: fromNumber,
                to,
                statusCallback: `${callbackBaseUrl}/api/webhook/sms-status?campaign_id=${campaignId}`,
            });
            await db_1.default.query(`INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tenantId, campaignId, message.sid, message.status, to, fromNumber, new Date().toISOString()]);
            console.log(`✅ SMS enviado a ${to} (SID: ${message.sid})`);
        }
        catch (error) {
            console.error(`❌ Error enviando SMS a ${to}:`, error.message);
            await db_1.default.query(`INSERT INTO sms_status_logs (
          tenant_id, campaign_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
                tenantId,
                campaignId,
                null,
                'failed',
                to,
                fromNumber,
                error.code || null,
                error.message || "Error desconocido",
                new Date().toISOString(),
            ]);
        }
    }
}
