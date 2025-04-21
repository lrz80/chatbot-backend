"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const openai_1 = __importDefault(require("openai"));
const incrementUsage_1 = require("../../lib/incrementUsage"); // ✅ importar función
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
        const prompt = tenant.prompt || 'Eres un asistente telefónico amigable y profesional.';
        // 🔮 Generar respuesta con OpenAI
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: userInput },
            ],
        });
        const respuesta = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
        // 💾 Guardar mensaje del usuario (voz)
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`, [tenant.id, userInput, fromNumber]);
        // 💾 Guardar respuesta del bot
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
       VALUES ($1, 'bot', $2, NOW(), 'voice')`, [tenant.id, respuesta]);
        // 🔢 Incrementar uso real
        await (0, incrementUsage_1.incrementarUsoPorNumero)(numero); // ✅ sumamos 1 solo si es canal real
        // 🗣️ Responder por voz
        const response = new twilio_1.twiml.VoiceResponse();
        response.say({ voice: tenant.voice_name || 'alice', language: tenant.voice_language || 'es-ES' }, respuesta);
        response.pause({ length: 1 });
        response.hangup();
        res.type('text/xml');
        res.send(response.toString());
    }
    catch (err) {
        console.error('❌ Error en voice-response:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
