"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const db_1 = __importDefault(require("../../lib/db"));
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    const to = req.body.To || '';
    const numero = to.replace('tel:', '');
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_voice_number = $1', [numero]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        const configRes = await db_1.default.query('SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1', [tenant.id, 'voz']);
        const config = configRes.rows[0];
        if (!config)
            return res.sendStatus(404);
        const response = new twilio_1.twiml.VoiceResponse();
        response.say({
            voice: config.voice_name || 'alice',
            language: config.idioma || 'es-ES',
        }, config.welcome_message || 'Hola, ¿en qué puedo ayudarte?');
        response.gather({
            input: ['speech'],
            action: '/webhook/voice-response',
            method: 'POST',
            language: config.idioma || 'es-ES',
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
