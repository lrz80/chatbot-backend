"use strict";
// 📁 src/routes/tenants.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
// ✅ Actualizar perfil del negocio
router.post('/', async (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const uid = decoded.uid;
        const userRes = await db_1.default.query('SELECT tenant_id FROM users WHERE uid = $1', [uid]);
        const user = userRes.rows[0];
        if (!user?.tenant_id) {
            return res.status(404).json({ error: 'Usuario sin tenant asociado' });
        }
        const { name, categoria, idioma = 'es', prompt = 'Eres un asistente útil.', } = req.body;
        if (!name || !categoria) {
            return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
        }
        const slug = name.toLowerCase().replace(/\s+/g, '-');
        await db_1.default.query(`UPDATE tenants
       SET name = $1, slug = $2, categoria = $3, idioma = $4, prompt = $5, bienvenida = $6
       WHERE id = $7`, [
            name,
            slug,
            categoria,
            idioma,
            prompt,
            '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte?',
            user.tenant_id,
        ]);
        res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('❌ Error en /api/tenants:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
