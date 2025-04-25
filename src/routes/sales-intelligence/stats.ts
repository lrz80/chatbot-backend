// ✅ src/routes/sales-intelligence/stats.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  try {
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM sales_intelligence WHERE tenant_id = $1`,
      [tenant_id]
    );

    const calientesRes = await pool.query(
      `SELECT COUNT(*) FROM sales_intelligence WHERE tenant_id = $1 AND nivel_interes >= 4`,
      [tenant_id]
    );

    res.json({
      total_intenciones: parseInt(totalRes.rows[0].count),
      leads_calientes: parseInt(calientesRes.rows[0].count),
    });
  } catch (err) {
    console.error('❌ Error en /sales-intelligence/stats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

export default router;
