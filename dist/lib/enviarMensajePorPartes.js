"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.enviarMensajePorPartes = enviarMensajePorPartes;
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../lib/db"));
async function enviarMensajePorPartes({ tenantId, canal, senderId, messageId, accessToken, respuesta, }) {
    const limiteFacebook = 980;
    const limiteWhatsApp = 4096;
    const limite = canal === 'whatsapp' ? limiteWhatsApp : limiteFacebook;
    let textoAEnviar = respuesta.trim();
    if (textoAEnviar.length > limite) {
        textoAEnviar = textoAEnviar.slice(0, limite - 3) + "...";
    }
    const messageFragmentId = `bot-${messageId}`;
    const yaExiste = await db_1.default.query(`SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`, [tenantId, messageFragmentId]);
    if (yaExiste.rows.length === 0) {
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'bot', $2, NOW(), $3, $4, $5)`, [tenantId, textoAEnviar, canal, senderId, messageFragmentId]);
        try {
            if (canal === 'facebook' || canal === 'instagram') {
                await axios_1.default.post(`https://graph.facebook.com/v19.0/me/messages`, {
                    recipient: { id: senderId },
                    message: { text: textoAEnviar },
                }, { params: { access_token: accessToken } });
            }
            else if (canal === 'whatsapp') {
                await axios_1.default.post(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, new URLSearchParams({
                    To: `whatsapp:${senderId}`,
                    From: `whatsapp:${process.env.TWILIO_NUMBER}`,
                    Body: textoAEnviar,
                }), {
                    auth: {
                        username: process.env.TWILIO_ACCOUNT_SID,
                        password: process.env.TWILIO_AUTH_TOKEN,
                    },
                });
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        catch (err) {
            console.error('❌ Error enviando mensaje:', err.response?.data || err.message || err);
        }
    }
    console.log(`✅ Mensaje enviado por ${canal}: ${textoAEnviar.length} caracteres`);
}
