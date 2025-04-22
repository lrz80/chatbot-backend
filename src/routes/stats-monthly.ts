import { Router, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router: Router = Router();

// GET /api/stats/monthly
router.get('/', authenticateUser, async (req: any, res: Response) => {
  const monthView = req.query.month === 'current' ? 'current' : 'year';
  const tenant_id = req.user?.tenant_id;

  if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const query =
      monthView === 'current'
        ? `
        SELECT DATE(timestamp) as dia, COUNT(*)::int as count
        FROM interactions
        WHERE tenant_id = $1 AND timestamp >= date_trunc('month', CURRENT_DATE)
        GROUP BY dia ORDER BY dia;
      `
        : `
        SELECT TO_CHAR(timestamp, 'YYYY-MM') as mes, COUNT(*)::int as count
        FROM interactions
        WHERE tenant_id = $1
        GROUP BY mes ORDER BY mes;
      `;

    const result = await pool.query(query, [tenant_id]);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('❌ Error en /stats/monthly:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
