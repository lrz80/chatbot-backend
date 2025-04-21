"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const router = (0, express_1.Router)();
// Primer paso: saludo inicial y recopilación por voz
router.post('/', async (req, res) => {
    const to = req.body.To || '';
    const from = req.body.From || '';
    const numero = to.replace('tel:', '');
    const fromNumber = from.replace('tel:', '');
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        const response = new twilio_1.twiml.VoiceResponse();
        // 💬 Saludo inicial
        response.say({ voice: 'alice', language: tenant.voice_language || 'es-ES' }, tenant.bienvenida || 'Hola, gracias por llamar. Por favor, dime en qué puedo ayudarte después del tono.');
        // 💾 Registrar llamada entrante (sin texto aún)
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`, [tenant.id, '[Inicio de llamada]', fromNumber]);
        // 🎙️ Recolección de voz
        response.gather({
            input: ['speech'],
            action: '/webhook/voice-response',
            method: 'POST',
            language: tenant.voice_language || 'es-ES',
            speechTimeout: 'auto',
        });
        res.type('text/xml');
        res.send(response.toString());
    }
    catch (err) {
        console.error('❌ Error en webhook de voz:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
