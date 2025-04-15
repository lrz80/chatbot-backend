import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', (req: Request, res: Response) => {
  (async () => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Token requerido' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

      const result = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(DISTINCT phone) AS usuarios,
                EXTRACT(HOUR FROM timestamp) AS hora_pico
         FROM interactions
         WHERE uid = $1
         GROUP BY hora_pico
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [decoded.uid]
      );

      const { total, usuarios, hora_pico } = result.rows[0] || {
        total: 0,
        usuarios: 0,
        hora_pico: null,
      };

      return res.status(200).json({ total, usuarios, hora_pico });
    } catch (error) {
      console.error('❌ Error en /stats/kpis:', error);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  })();
});

export default router;
