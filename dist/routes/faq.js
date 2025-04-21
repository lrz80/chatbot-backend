"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
// GET: Obtener FAQs
router.get('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const tenantRes = await db_1.default.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
        const tenantId = tenantRes.rows[0]?.id;
        if (!tenantId)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const faqRes = await db_1.default.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenantId]);
        return res.status(200).json(faqRes.rows);
    }
    catch (err) {
        console.error('❌ Error al obtener FAQ:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
// POST: Guardar FAQs
router.post('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const { faqs } = req.body;
        const tenantRes = await db_1.default.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
        const tenantId = tenantRes.rows[0]?.id;
        if (!tenantId)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        // Limpiar anteriores
        await db_1.default.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);
        for (const item of faqs) {
            await db_1.default.query('INSERT INTO faqs (tenant_id, pregunta, respuesta) VALUES ($1, $2, $3)', [tenantId, item.pregunta, item.respuesta]);
        }
        return res.status(200).json({ message: 'FAQs actualizadas' });
    }
    catch (err) {
        console.error('❌ Error al guardar FAQ:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
