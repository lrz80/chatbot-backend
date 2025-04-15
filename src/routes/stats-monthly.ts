import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', (req: Request, res: Response) => {
  (async () => {
    const token = req.headers.authorization?.split(' ')[1];
    const monthView = req.query.month === 'current' ? 'current' : 'year';

    if (!token) return res.status(401).json({ error: 'Token requerido' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

      const query =
        monthView === 'current'
          ? `
          SELECT DATE(timestamp) as dia, COUNT(*)::int as count
          FROM interactions
          WHERE uid = $1 AND timestamp >= date_trunc('month', CURRENT_DATE)
          GROUP BY dia ORDER BY dia;
        `
          : `
          SELECT TO_CHAR(timestamp, 'YYYY-MM') as mes, COUNT(*)::int as count
          FROM interactions
          WHERE uid = $1
          GROUP BY mes ORDER BY mes;
        `;

      const result = await pool.query(query, [decoded.uid]);

      return res.status(200).json(result.rows);
    } catch (error) {
      console.error('❌ Error en /stats/monthly:', error);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  })();
});

export default router;
