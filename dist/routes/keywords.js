"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) {
        return res.status(400).json({ error: 'Tenant ID no encontrado' });
    }
    try {
        const result = await db_1.default.query(`
      SELECT LOWER(word) AS palabra, COUNT(*) AS cantidad
      FROM (
        SELECT unnest(string_to_array(content, ' ')) AS word
        FROM messages
        WHERE tenant_id = $1 AND role = 'user'
      ) AS palabras
      WHERE LENGTH(word) > 2
      GROUP BY palabra
      ORDER BY cantidad DESC
      LIMIT 10
      `, [tenant_id]);
        const keywords = result.rows.map((row) => [row.palabra, parseInt(row.cantidad)]);
        res.status(200).json({ keywords });
    }
    catch (err) {
        console.error('❌ Error al generar keywords dinámicamente:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
