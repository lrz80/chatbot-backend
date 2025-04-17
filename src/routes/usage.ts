// 📁 src/routes/usage.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const result = await pool.query(
      'SELECT used, limit, porcentaje, plan FROM usage_limits WHERE uid = $1',
      [decoded.uid]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ used: 0, limit: 0, porcentaje: 0, plan: "free" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Error en /usage:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
