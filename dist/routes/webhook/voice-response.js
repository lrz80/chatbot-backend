"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const openai_1 = __importDefault(require("openai"));
const incrementUsage_1 = require("../../lib/incrementUsage");
const router = (0, express_1.Router)();
const openai = new openai_1.default({
    apiKey: process.env.OPENAI_API_KEY,
});
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
        // 🔮 OpenAI genera la respuesta
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: userInput },
            ],
        });
        const respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
        // 💾 Guardar mensaje del cliente
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`, [tenant.id, userInput, fromNumber]);
        // 💾 Guardar respuesta del bot
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`, [tenant.id, respuesta]);
        // 💾 Registrar interacción
        await db_1.default.query(`INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`, [tenant.id]);
        // 🔢 Contabilizar uso real
        await (0, incrementUsage_1.incrementarUsoPorNumero)(numero);
        // 🧠 Detectar intención de cierre
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
