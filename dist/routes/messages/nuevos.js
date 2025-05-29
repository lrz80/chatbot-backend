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
        // 🛡️ Validar que lastId sea un UUID válido o null
        if (lastId && !(0, uuid_1.validate)(lastId)) {
            return res.status(400).json({ error: 'ID inválido (UUID esperado)' });
        }
        const query = canal
            ? `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 AND m.canal = $2 ${lastId ? 'AND m.id > $3' : ''}
         ORDER BY m.id ASC
         LIMIT 20`
            : `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 ${lastId ? 'AND m.id > $2' : ''}
         ORDER BY m.id ASC
         LIMIT 20`;
        const values = canal
            ? lastId ? [tenant_id, canal, lastId] : [tenant_id, canal]
            : lastId ? [tenant_id, lastId] : [tenant_id];
        const mensajesRes = await db_1.default.query(query, values);
        res.status(200).json({ mensajes: mensajesRes.rows });
    }
    catch (error) {
        console.error("❌ Error al obtener mensajes nuevos:", error);
        res.status(500).json({ error: "Error al obtener nuevos mensajes" });
    }
});
exports.default = router;
