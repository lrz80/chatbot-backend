"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const incrementUsage_1 = require("../../lib/incrementUsage");
const router = (0, express_1.Router)();
// 🔍 Función para normalizar texto (sin tildes, minúsculas)
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}
router.post('/', async (req, res) => {
    const to = req.body.To || '';
    const from = req.body.From || '';
    const numero = to.replace('tel:', '');
    const fromNumber = from.replace('tel:', '');
    const userInput = req.body.SpeechResult || 'No se recibió mensaje.';
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        const configRes = await db_1.default.query('SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1', [tenant.id, 'voz']);
        const config = configRes.rows[0];
        if (!config)
            return res.sendStatus(404);
        const prompt = config.system_prompt || 'Eres un asistente telefónico amigable y profesional.';
        const voiceLang = config.idioma || 'es-ES';
        const voiceName = config.voice_name || 'alice';
        const mensajeUsuario = normalizarTexto(userInput);
        // 📚 Leer FAQs
        let respuestaFAQ = null;
        try {
            const faqsRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant.id]);
            const faqs = faqsRes.rows || [];
            for (const faq of faqs) {
                if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
                    respuestaFAQ = faq.respuesta;
                    break;
                }
            }
        }
        catch (e) {
            console.warn('⚠️ No se pudieron cargar FAQs:', e);
        }
        let respuesta = null;
        if (respuestaFAQ) {
            respuesta = respuestaFAQ;
        }
        else {
            // 🔑 Instanciar OpenAI solo si es necesario
            const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require('openai')));
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
            const completion = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: userInput },
                ],
            });
            respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
        }
        // 🧠 Detectar emoción
        let emocion = 'neutral';
        try {
            const { default: OpenAI } = await Promise.resolve().then(() => __importStar(require('openai')));
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
            const emotionPrompt = `
Actúa como un analista emocional. Clasifica la emoción dominante en este mensaje del cliente:
"${userInput}"

Elige solo una palabra: enfado, tristeza, neutral, satisfacción o entusiasmo.
      `;
            const emotionRes = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: emotionPrompt },
                ],
            });
            emocion = emotionRes.choices[0].message?.content?.trim().toLowerCase() || 'neutral';
        }
        catch (e) {
            console.warn('⚠️ No se pudo analizar emoción:', e);
        }
        // 💾 Guardar mensaje y respuesta
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, emotion)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3, $4)`, [tenant.id, userInput, fromNumber, emocion]);
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`, [tenant.id, respuesta]);
        await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`, [tenant.id]);
        await (0, incrementUsage_1.incrementarUsoPorNumero)(numero);
        const finConversacion = /(gracias|eso es todo|nada más|bye|adiós)/i.test(userInput);
        const response = new twilio_1.twiml.VoiceResponse();
        response.say({ voice: voiceName, language: voiceLang }, respuesta);
        if (!finConversacion) {
            response.gather({
                input: ['speech'],
                action: '/webhook/voice-response',
                method: 'POST',
                language: voiceLang,
                speechTimeout: 'auto',
            });
        }
        else {
            response.say({ voice: voiceName, language: voiceLang }, 'Gracias por tu llamada. ¡Hasta luego!');
            response.hangup();
        }
        res.type('text/xml');
        res.send(response.toString());
    }
    catch (err) {
        console.error('❌ Error en voice-response:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
