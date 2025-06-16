"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// 🧠 Intenciones de venta por día (últimos 7 días)
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id)
        return res.status(401).json({ error: 'Tenant no autenticado' });
    try {
        const result = await db_1.default.query(`
      SELECT
        DATE(fecha) AS dia,
        COUNT(*) AS count
      FROM sales_intelligence
      WHERE tenant_id = $1
        AND fecha >= NOW() - INTERVAL '7 days'
        AND LOWER(intencion) IN ('comprar', 'pagar', 'precio', 'reservar', 'agendar')
        AND nivel_interes >= 2
      GROUP BY dia
      ORDER BY dia ASC;
      `, [tenant_id]);
        res.status(200).json(result.rows);
    }
    catch (err) {
        console.error('❌ Error al obtener intenciones por día:', err);
        res.status(500).json({ error: 'Error al obtener datos' });
    }
});
exports.default = router;
