"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSMSNotificacion = sendSMSNotificacion;
const twilio_1 = __importDefault(require("twilio"));
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
// 🔥 Número fijo para notificaciones Aamy AI
const fromNumber = '+14455451224';
async function sendSMSNotificacion(mensaje, destinatarios) {
    for (const rawTo of destinatarios) {
        const to = normalizarNumero(rawTo);
        if (!/^\+\d{10,15}$/.test(to)) {
            console.warn(`❌ Número inválido para SMS: ${rawTo}`);
            continue;
        }
        if (to === fromNumber) {
            console.warn(`⚠️ El número de destino y origen son iguales: ${to}`);
            continue;
        }
        try {
            const message = await client.messages.create({
                body: mensaje,
                from: fromNumber,
                to,
                statusCallback: `${callbackBaseUrl}/api/webhook/sms-status?campaign_id=0`,
            });
            console.log(`✅ SMS de notificación enviado a ${to} (SID: ${message.sid})`);
        }
        catch (error) {
            console.error(`❌ Error enviando SMS de notificación a ${to}:`, error.message);
        }
    }
}
