"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const axios_1 = __importDefault(require("axios"));
const uploadAudioToCDN_1 = require("../../utils/uploadAudioToCDN");
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    const to = req.body.To || '';
    const numero = to.replace('tel:', '');
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        const configRes = await db_1.default.query('SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 ORDER BY created_at DESC LIMIT 1', [tenant.id, 'voz']);
        const config = configRes.rows[0];
        if (!config)
            return res.sendStatus(404);
        const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
        const idioma = config.idioma || 'es-ES';
        // ✅ Saludo con SSML (pausas naturales)
        const textoBienvenida = config.welcome_message || 'Hola, ¿en qué puedo ayudarte?';
        const ssmlBienvenida = `<speak>${textoBienvenida.replace(/\.\s*/g, '. <break time="400ms"/> ')}</speak>`;
        const audioRes = await axios_1.default.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            text: ssmlBienvenida,
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
                stability: 0.4,
                similarity_boost: 0.8,
            },
        }, {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/ssml+xml',
                Accept: 'audio/mpeg',
            },
            responseType: 'arraybuffer',
        });
        const audioBuffer = Buffer.from(audioRes.data);
        const audioUrl = await (0, uploadAudioToCDN_1.guardarAudioEnCDN)(audioBuffer, tenant.id);
        // ✅ (opcional) Guardar demo generado
        await db_1.default.query(`UPDATE voice_configs SET audio_demo_url = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND canal = 'voz'`, [audioUrl, tenant.id]);
        const response = new twilio_1.twiml.VoiceResponse();
        response.play(audioUrl);
        response.gather({
            input: ['speech'],
            action: '/webhook/voice-response',
            method: 'POST',
            language: idioma,
            speechTimeout: 'auto',
        });
        res.type('text/xml').send(response.toString());
    }
    catch (err) {
        console.error('❌ Error en webhook de voz:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
