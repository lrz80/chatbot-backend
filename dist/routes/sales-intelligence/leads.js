"use strict";
// 📁 src/routes/sales-intelligence/leads.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// 📋 GET: Obtener leads de ventas con análisis de scoring
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    const { canal, nivel_minimo = 1 } = req.query;
    try {
        let query = `
      SELECT 
        contacto, 
        canal, 
        mensaje, 
        intencion, 
        nivel_interes, 
        fecha,
        CASE
          WHEN nivel_interes >= 4 THEN 'lead_caliente'
          WHEN nivel_interes = 2 OR nivel_interes = 3 THEN 'lead_tibio'
          ELSE 'lead_frio'
        END AS tipo_lead
      FROM sales_intelligence
      WHERE tenant_id = $1 AND nivel_interes >= $2
    `;
        const params = [tenant_id, nivel_minimo];
        if (canal && canal !== "todos") {
            query += ` AND canal = $3`;
            params.push(canal);
        }
        query += ` ORDER BY fecha DESC`;
        const result = await db_1.default.query(query, params);
        res.json(result.rows);
    }
    catch (err) {
        console.error('❌ Error en /sales-intelligence/leads:', err);
        res.status(500).json({ error: 'Error al obtener leads' });
    }
});
exports.default = router;
