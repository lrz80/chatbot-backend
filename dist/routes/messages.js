"use strict";
// 📁 src/routes/messages.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        // Parámetros de query
        const canal = req.query.canal?.toString() || "";
        const limit = parseInt(req.query.limit) || 10;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;
        // Construcción dinámica de consulta
        const query = canal
            ? `SELECT id, tenant_id, content, sender, canal, timestamp, from_number 
         FROM messages 
         WHERE tenant_id = $1 AND canal = $2 
         ORDER BY timestamp DESC 
         LIMIT $3 OFFSET $4`
            : `SELECT id, tenant_id, content, sender, canal, timestamp, from_number 
         FROM messages 
         WHERE tenant_id = $1 
         ORDER BY timestamp DESC 
         LIMIT $2 OFFSET $3`;
        const values = canal
            ? [tenant_id, canal, limit, offset]
            : [tenant_id, limit, offset];
        const mensajesRes = await db_1.default.query(query, values);
        res.status(200).json(mensajesRes.rows);
    }
    catch (error) {
        console.error("❌ Error al obtener historial:", error);
        res.status(500).json({ error: "Error al obtener mensajes" });
    }
});
exports.default = router;
