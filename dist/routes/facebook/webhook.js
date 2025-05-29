"use strict";
// src/routes/facebook/webhook.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const detectarIdioma_1 = require("../../lib/detectarIdioma");
const traducirMensaje_1 = require("../../lib/traducirMensaje");
const respuestasTraducidas_1 = require("../../lib/respuestasTraducidas");
const incrementUsage_1 = require("../../lib/incrementUsage");
const detectarIntencion_1 = require("../../lib/detectarIntencion");
const enviarMensajePorPartes_1 = require("../../lib/enviarMensajePorPartes");
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
const router = express_1.default.Router();
router.get('/api/facebook/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook de Facebook verificado');
            return res.status(200).send(challenge);
        }
        else {
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});
router.post('/api/facebook/webhook', async (req, res) => {
    console.log("🌐 Webhook Meta recibido:", JSON.stringify(req.body, null, 2));
    try {
        const body = req.body;
        if (body.object !== 'page' && body.object !== 'instagram')
            return res.sendStatus(404);
        res.sendStatus(200);
        for (const entry of body.entry) {
            const pageId = entry.id;
            for (const messagingEvent of entry.messaging) {
                if (!messagingEvent.message || messagingEvent.message.is_echo || !messagingEvent.message.text) {
                    console.log('⏭️ Evento ignorado');
                    continue;
                }
                const senderId = messagingEvent.sender.id;
                const messageId = messagingEvent.message.mid;
                const userMessage = messagingEvent.message.text;
                const idioma = await (0, detectarIdioma_1.detectarIdioma)(userMessage);
                const { rows } = await db_1.default.query('SELECT * FROM tenants WHERE facebook_page_id = $1 OR instagram_page_id = $1 LIMIT 1', [pageId]);
                if (rows.length === 0)
                    continue;
                const tenant = rows[0];
                const isInstagram = tenant.instagram_page_id && tenant.instagram_page_id === senderId;
                const canal = isInstagram ? 'instagram' : 'facebook';
                const tenantId = tenant.id;
                const accessToken = tenant.facebook_access_token;
                const existingMsg = await db_1.default.query(`SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`, [tenantId, messageId]);
                if (existingMsg.rows.length > 0)
                    continue;
                let faqs = [];
                let flows = [];
                try {
                    const resFaqs = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenantId]);
                    faqs = resFaqs.rows || [];
                }
                catch { }
                try {
                    const resFlows = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenantId]);
                    const raw = resFlows.rows[0]?.data;
                    flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (!Array.isArray(flows))
                        flows = [];
                }
                catch { }
                const { intencion, nivel_interes } = await (0, detectarIntencion_1.detectarIntencion)(userMessage);
                const intencionLower = intencion?.toLowerCase() || '';
                let respuesta = null;
                // 🚦 Detectar intención de finalizar conversación
                if (["finalizar", "cerrar", "terminar", "gracias", "eso es todo", "no necesito más"].some(p => intencionLower.includes(p))) {
                    respuesta = "¡Gracias por contactarnos! Si necesitas más información, no dudes en escribirnos. ¡Hasta pronto!";
                }
                else {
                    respuesta = await (0, respuestasTraducidas_1.buscarRespuestaSimilitudFaqsTraducido)(faqs, userMessage, idioma)
                        ?? await (0, respuestasTraducidas_1.buscarRespuestaDesdeFlowsTraducido)(flows, userMessage, idioma);
                    if (!respuesta) {
                        const promptMeta = tenant.prompt_meta?.trim() ?? "Información del negocio no disponible.";
                        const prompt = `Eres un asistente virtual para un negocio local. Un cliente preguntó: "${userMessage}". Responde de manera clara, breve y útil usando esta información del negocio:\n\n${promptMeta}`;
                        try {
                            const completion = await openai.chat.completions.create({
                                messages: [{ role: 'user', content: prompt }],
                                model: 'gpt-3.5-turbo',
                                max_tokens: 500,
                            });
                            respuesta = completion.choices[0]?.message?.content?.trim() ?? promptMeta;
                            const tokensConsumidos = completion.usage?.total_tokens || 0;
                            if (tokensConsumidos > 0) {
                                await db_1.default.query(`UPDATE uso_mensual
                  SET usados = usados + $1
                  WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`, [tokensConsumidos, tenantId]);
                            }
                        }
                        catch (error) {
                            console.error('❌ Error con OpenAI:', error);
                            respuesta = promptMeta;
                        }
                    }
                }
                // 🔒 Aseguramos que siempre sea string
                respuesta = respuesta ?? "Lo siento, no tengo información disponible.";
                // 🌐 Traducir si es necesario
                const idiomaFinal = await (0, detectarIdioma_1.detectarIdioma)(respuesta);
                if (idiomaFinal !== idioma) {
                    respuesta = await (0, traducirMensaje_1.traducirMensaje)(respuesta, idioma);
                }
                // 📝 Guardar mensajes e interacciones
                await db_1.default.query(`INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
           VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, senderId, canal, userMessage, intencion, nivel_interes]);
                const existeUsuario = await db_1.default.query(`SELECT 1 FROM messages WHERE tenant_id = $1 AND sender = 'user' AND message_id = $2 LIMIT 1`, [tenantId, messageId]);
                if (existeUsuario.rows.length === 0) {
                    await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`, [tenantId, userMessage, canal, senderId, messageId]);
                }
                const yaExisteContenidoReciente = await db_1.default.query(`SELECT 1 FROM messages 
          WHERE tenant_id = $1 AND sender = 'bot' AND canal = $2 AND content = $3 
          AND timestamp >= NOW() - INTERVAL '5 seconds'
          LIMIT 1`, [tenantId, canal, respuesta]);
                if (yaExisteContenidoReciente.rows.length === 0) {
                    try {
                        await (0, enviarMensajePorPartes_1.enviarMensajePorPartes)({
                            respuesta,
                            senderId,
                            tenantId,
                            canal,
                            messageId,
                            accessToken,
                        });
                    }
                    catch (err) {
                        console.error('❌ Error al enviar mensaje por partes:', err);
                    }
                }
                await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at) VALUES ($1, $2, NOW())`, [tenantId, canal]);
                await (0, incrementUsage_1.incrementarUsoPorNumero)(tenant.twilio_number);
            }
        }
    }
    catch (error) {
        console.error('❌ Error en webhook:', error.response?.data || error.message || error);
    }
});
exports.default = router;
