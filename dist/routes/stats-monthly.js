"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
router.get('/', async (req, res) => {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    const monthView = req.query.month === 'current' ? 'current' : 'year';
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const tenant_id = decoded.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant ID no encontrado' });
        const query = monthView === 'current'
            ? `
        SELECT DATE(created_at) as dia, COUNT(*)::int as count
        FROM interactions
        WHERE tenant_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)
        GROUP BY dia ORDER BY dia;
      `
            : `
        SELECT TO_CHAR(created_at, 'YYYY-MM') as mes, COUNT(*)::int as count
        FROM interactions
        WHERE tenant_id = $1
        GROUP BY mes ORDER BY mes;
      `;
        const result = await db_1.default.query(query, [tenant_id]);
        return res.status(200).json(result.rows);
    }
    catch (error) {
        console.error('❌ Error en /stats/monthly:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
