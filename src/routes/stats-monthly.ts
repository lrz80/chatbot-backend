import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  const monthView = req.query.month === 'current' ? 'current' : 'year';

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;

    if (!tenant_id) return res.status(401).json({ error: 'Tenant ID no encontrado' });

    const query =
      monthView === 'current'
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

    const result = await pool.query(query, [tenant_id]);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('❌ Error en /stats/monthly:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
