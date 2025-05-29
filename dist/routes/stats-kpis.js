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
router.get('/kpis', async (req, res) => {
    const token = req.cookies.token;
    const canal = req.query.canal;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const tenant_id = decoded.tenant_id;
        if (!tenant_id)
            return res.status(404).json({ error: 'Tenant no encontrado' });
        const canalFilter = canal ? `AND canal = '${canal}'` : '';
        // Totales y usuarios únicos
        const generalStats = await db_1.default.query(`SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT from_number)::int AS unicos
       FROM messages
       WHERE tenant_id = $1 ${canalFilter}`, [tenant_id]);
        // Hora pico
        const horaPicoRes = await db_1.default.query(`SELECT EXTRACT(HOUR FROM timestamp)::int AS hora,
              COUNT(*) AS total
       FROM messages
       WHERE tenant_id = $1 AND sender = 'user' ${canalFilter}
       AND timestamp >= NOW() - INTERVAL '7 days'
       GROUP BY hora
       ORDER BY total DESC
       LIMIT 1`, [tenant_id]);
        // Intenciones de venta (desde tabla sales_intelligence)
        const ventasRes = await db_1.default.query(`SELECT COUNT(*)::int AS intenciones
       FROM sales_intelligence
       WHERE tenant_id = $1 ${canalFilter}
         AND (LOWER(intencion) LIKE '%compra%' OR LOWER(intencion) LIKE '%pagar%' OR LOWER(intencion) LIKE '%precio%' OR LOWER(intencion) LIKE '%reservar%' OR LOWER(intencion) LIKE '%agendar%')`, [tenant_id]);
        const total = generalStats.rows[0]?.total || 0;
        const unicos = generalStats.rows[0]?.unicos || 0;
        const hora_pico = horaPicoRes.rows[0]?.hora || null;
        const intenciones_venta = ventasRes.rows[0]?.intenciones || 0;
        return res.status(200).json({ total, unicos, hora_pico, intenciones_venta });
    }
    catch (error) {
        console.error('❌ Error en /api/stats/kpis:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
