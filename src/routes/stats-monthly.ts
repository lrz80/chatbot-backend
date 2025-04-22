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
    const uid = decoded.uid;

    // Obtener tenant_id desde la base de datos
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [uid]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const tenant_id = tenant.id;

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
