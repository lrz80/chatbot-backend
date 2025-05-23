"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/facebook/webhook.ts
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../../lib/db")); // Ajusta si tu conexión es diferente
const getRespuestaCompleta_1 = require("../../lib/getRespuestaCompleta"); // Aquí ya OpenAI se usa de forma segura
const router = express_1.default.Router();
const mensajeDefault = 'Lo siento, no tengo una respuesta para eso en este momento.';
// Verificación de Webhook
router.get('/api/facebook/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook de Facebook verificado');
            res.status(200).send(challenge);
        }
        else {
            res.sendStatus(403);
        }
    }
});
// Mensajes entrantes
router.post('/api/facebook/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'page') {
            return res.sendStatus(404);
        }
        for (const entry of body.entry) {
            const pageId = entry.id;
            for (const messagingEvent of entry.messaging) {
                const senderId = messagingEvent.sender.id;
                if (messagingEvent.message && !messagingEvent.message.is_echo) {
                    const userMessage = messagingEvent.message.text || '';
                    console.log('📩 Mensaje recibido:', userMessage);
                    // 1. Buscar el tenant por page_id
                    const { rows } = await db_1.default.query('SELECT facebook_access_token, prompt_meta, bienvenida_meta, horario_atencion FROM tenants WHERE facebook_page_id = $1 LIMIT 1', [pageId]);
                    if (rows.length === 0) {
                        console.error('❌ No se encontró tenant para page_id:', pageId);
                        continue;
                    }
                    const tenant = rows[0];
                    const accessToken = tenant.facebook_access_token;
                    tenant.id = tenant.id || pageId; // asegurarse que tenga tenant.id
                    const respuestaFinal = await (0, getRespuestaCompleta_1.getRespuestaCompleta)({
                        canal: 'facebook',
                        tenant,
                        input: userMessage,
                    });
                    // 5. Enviar respuesta
                    await axios_1.default.post(`https://graph.facebook.com/v19.0/me/messages`, {
                        recipient: { id: senderId },
                        message: { text: respuestaFinal },
                    }, {
                        params: { access_token: accessToken },
                    });
                    console.log('✅ Respuesta enviada al usuario');
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    }
    catch (error) {
        console.error('❌ Error en webhook:', error.response?.data || error.message || error);
        res.sendStatus(500);
    }
});
exports.default = router;
