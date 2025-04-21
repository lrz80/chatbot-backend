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
// ✅ GET → Obtener el prompt actual
router.get('/', async (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const uid = decoded.uid;
        const tenantRes = await db_1.default.query('SELECT prompt FROM tenants WHERE admin_uid = $1', [uid]);
        if (tenantRes.rows.length === 0) {
            return res.status(404).json({ error: 'Negocio no encontrado' });
        }
        return res.status(200).json({
            system_prompt: tenantRes.rows[0].prompt,
        });
    }
    catch (error) {
        console.error('❌ Error obteniendo prompt:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// ✅ POST → Guardar nuevo prompt
router.post('/', async (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const uid = decoded.uid;
        const { system_prompt } = req.body;
        if (!system_prompt) {
            return res.status(400).json({ error: 'Prompt requerido' });
        }
        const updateRes = await db_1.default.query('UPDATE tenants SET prompt = $1 WHERE admin_uid = $2 RETURNING id', [system_prompt, uid]);
        if (updateRes.rowCount === 0) {
            return res.status(404).json({ error: 'Negocio no encontrado' });
        }
        return res.status(200).json({ message: 'Prompt actualizado' });
    }
    catch (error) {
        console.error('❌ Error actualizando prompt:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
