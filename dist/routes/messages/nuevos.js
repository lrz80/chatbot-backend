"use strict";
// 📁 src/routes/messages-nuevos.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const uuid_1 = require("uuid");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const canal = req.query.canal?.toString() || "";
        const lastId = req.query.lastId?.toString();
        if (lastId && !(0, uuid_1.validate)(lastId)) {
            return res.status(400).json({ error: 'ID inválido (UUID esperado)' });
        }
        let query = `
      SELECT 
        m.id, m.tenant_id, m.content, m.role, m.canal, m.timestamp, m.from_number, m.emotion,
        s.intencion, s.nivel_interes
      FROM messages m
      LEFT JOIN sales_intelligence s
        ON m.from_number = s.contacto AND m.content = s.mensaje
      WHERE m.tenant_id = $1
    `;
        const values = [tenant_id];
        let paramIndex = 2;
        if (canal) {
            query += ` AND m.canal = $${paramIndex++}`;
            values.push(canal);
        }
        if (lastId) {
            query += ` AND m.id > $${paramIndex++}`;
            values.push(lastId);
        }
        query += ` ORDER BY m.id ASC LIMIT 20`;
        const mensajesRes = await db_1.default.query(query, values);
        return res.status(200).json({ mensajes: mensajesRes.rows });
    }
    catch (error) {
        console.error("❌ Error al obtener mensajes nuevos:", error);
        return res.status(500).json({ error: "Error al obtener nuevos mensajes" });
    }
});
exports.default = router;
