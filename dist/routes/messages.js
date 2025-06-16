"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/messages.ts
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const canal = req.query.canal?.toString();
        const limit = parseInt(req.query.limit) || 10;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;
        const values = [tenant_id];
        let query = `
    SELECT DISTINCT ON (m.message_id)
      m.id, m.message_id, m.tenant_id, m.content, m.role, m.canal, m.timestamp, m.from_number, m.emotion,
      s.intencion, s.nivel_interes,
      c.nombre AS nombre_cliente
    FROM messages m
    LEFT JOIN sales_intelligence s
      ON m.tenant_id = s.tenant_id AND m.message_id = s.message_id
    LEFT JOIN clientes c
      ON m.tenant_id = c.tenant_id AND m.from_number = c.contacto
    WHERE m.tenant_id = $1
  `;
        if (canal) {
            query += ` AND m.canal = $2`;
            values.push(canal);
        }
        query += `
      ORDER BY m.message_id, m.timestamp DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;
        values.push(limit, offset);
        const mensajesRes = await db_1.default.query(query, values);
        res.status(200).json({ mensajes: mensajesRes.rows });
    }
    catch (error) {
        console.error("❌ Error al obtener historial:", error);
        res.status(500).json({ error: "Error al obtener mensajes" });
    }
});
exports.default = router;
