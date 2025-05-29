"use strict";
// src/routes/stats/hora-pico.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// ⏰ Hora pico de mayor interacción (últimos 7 días)
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id)
        return res.status(401).json({ error: 'Tenant no autenticado' });
    try {
        const result = await db_1.default.query(`
      SELECT
        EXTRACT(HOUR FROM timestamp) AS hora,
        COUNT(*) AS cantidad
      FROM messages
      WHERE tenant_id = $1
        AND sender = 'user'
        AND timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY hora
      ORDER BY cantidad DESC
      LIMIT 1;
      `, [tenant_id]);
        if (result.rows.length > 0) {
            res.status(200).json({
                hora_pico: parseInt(result.rows[0].hora),
                cantidad: parseInt(result.rows[0].cantidad),
            });
        }
        else {
            res.status(200).json({ hora_pico: null, cantidad: 0 });
        }
    }
    catch (err) {
        console.error('❌ Error al obtener hora pico:', err);
        res.status(500).json({ error: 'Error al obtener datos' });
    }
});
exports.default = router;
