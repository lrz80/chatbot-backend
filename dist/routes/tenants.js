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
// ✅ Crear tenant (negocio)
router.post('/', async (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const admin_uid = decoded.uid;
        const { name, categoria, idioma = 'es', prompt = 'Eres un asistente útil.', } = req.body;
        if (!name || !categoria) {
            return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
        }
        const slug = name.toLowerCase().replace(/\s+/g, '-');
        // Verifica si el usuario ya tiene un tenant
        const existing = await db_1.default.query('SELECT * FROM tenants WHERE admin_uid = $1', [admin_uid]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'El negocio ya existe' });
        }
        await db_1.default.query(`INSERT INTO tenants (
        name, slug, admin_uid, categoria, idioma, prompt, bienvenida, 
        membresia_activa, membresia_vigencia, onboarding_completado, limite_uso, used
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        true, NOW() + interval '30 days', true, 150, 0
      )`, [
            name,
            slug,
            admin_uid,
            categoria,
            idioma,
            prompt,
            '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte?',
        ]);
        res.status(201).json({ success: true });
    }
    catch (error) {
        console.error('❌ Error en /api/tenants:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
