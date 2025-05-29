"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ✅ GET: Obtener FAQs
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenantId = req.user?.tenant_id;
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
// ✅ POST: Guardar FAQs con validación
router.post('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenantId = req.user?.tenant_id;
        const { faqs } = req.body;
        if (!tenantId)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        // 🔒 Filtrar FAQs vacías
        const faqsFiltradas = (faqs || []).filter((item) => item.pregunta?.toString().trim() !== '' &&
            item.respuesta?.toString().trim() !== '');
        if (faqsFiltradas.length === 0) {
            return res.status(400).json({ error: 'No se recibieron FAQs válidas' });
        }
        await db_1.default.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);
        for (const item of faqsFiltradas) {
            await db_1.default.query('INSERT INTO faqs (tenant_id, pregunta, respuesta) VALUES ($1, $2, $3)', [tenantId, item.pregunta.trim(), item.respuesta.trim()]);
        }
        return res.status(200).json({ message: 'FAQs actualizadas' });
    }
    catch (err) {
        console.error('❌ Error al guardar FAQ:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
