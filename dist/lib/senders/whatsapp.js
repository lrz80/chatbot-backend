"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsApp = sendWhatsApp;
const twilio_1 = __importDefault(require("twilio"));
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = (0, twilio_1.default)(accountSid, authToken);
/**
 * Envía un mensaje de WhatsApp a una lista de destinatarios usando el número Twilio del tenant.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { telefono: string }
 * @param fromNumber Número de Twilio del tenant (formato: whatsapp:+123456789)
 */
async function sendWhatsApp(contenido, contactos, fromNumber) {
    for (const contacto of contactos) {
        if (!contacto.telefono)
            continue;
        try {
            await client.messages.create({
                body: contenido,
                from: fromNumber,
                to: `whatsapp:${contacto.telefono}`,
            });
            console.log(`✅ WhatsApp enviado a ${contacto.telefono}`);
        }
        catch (err) {
            console.error(`❌ Error enviando a ${contacto.telefono}:`, err);
        }
    }
}
