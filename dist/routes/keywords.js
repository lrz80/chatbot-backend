"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/keywords.ts
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
router.get('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const uid = decoded.uid;
        // Busca el tenant por admin_uid
        const tenantRes = await db_1.default.query('SELECT id FROM tenants WHERE admin_uid = $1', [uid]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        const result = await db_1.default.query('SELECT palabra, cantidad FROM keywords WHERE tenant_id = $1 ORDER BY cantidad DESC LIMIT 10', [tenant.id]);
        const keywords = result.rows.map((row) => [row.palabra, row.cantidad]);
        res.json({ keywords });
    }
    catch (err) {
        console.error('❌ Error al obtener keywords:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
