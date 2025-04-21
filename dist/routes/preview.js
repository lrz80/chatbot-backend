"use strict";
// src/routes/preview.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const openai_1 = __importDefault(require("openai"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
router.post('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const { message } = req.body;
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE admin_uid = $1', [decoded.uid]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const prompt = tenant.prompt || 'Eres un asistente útil y profesional.';
        const bienvenida = tenant.bienvenida || '¡Hola! ¿En qué puedo ayudarte?';
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: message },
            ],
        });
        const response = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
        return res.status(200).json({ response });
    }
    catch (err) {
        console.error('❌ Error en preview:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
