import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    // 🔍 Buscar tenant_id del usuario
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [uid]);
    const tenant_id = userRes.rows[0]?.tenant_id;

    if (!tenant_id) return res.status(404).json({ error: 'Tenant no encontrado' });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT phone) AS usuarios,
              EXTRACT(HOUR FROM timestamp) AS hora_pico
       FROM interactions
       WHERE tenant_id = $1
       GROUP BY hora_pico
       ORDER BY COUNT(*) DESC
       LIMIT 1`,
      [tenant_id]
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
});

export default router;
