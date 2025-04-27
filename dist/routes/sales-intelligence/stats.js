"use strict";
// ✅ src/routes/sales-intelligence/stats.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    try {
        const totalRes = await db_1.default.query(`SELECT COUNT(*) FROM sales_intelligence WHERE tenant_id = $1`, [tenant_id]);
        const calientesRes = await db_1.default.query(`SELECT COUNT(*) FROM sales_intelligence WHERE tenant_id = $1 AND nivel_interes >= 4`, [tenant_id]);
        res.json({
            total_intenciones: parseInt(totalRes.rows[0].count),
            leads_calientes: parseInt(calientesRes.rows[0].count),
        });
    }
    catch (err) {
        console.error('❌ Error en /sales-intelligence/stats:', err);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});
exports.default = router;
