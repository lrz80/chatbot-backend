// src/routes/stats-kpis.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/kpis', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;

    if (!tenant_id) return res.status(404).json({ error: 'Tenant no encontrado' });

    // 1. Total y únicos
    const generalStats = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT phone)::int AS unicos
      FROM interactions
      WHERE tenant_id = $1`,
      [tenant_id]
    );

    // 2. Hora pico
    const horaPicoRes = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hora,
              COUNT(*) AS total
      FROM interactions
      WHERE tenant_id = $1
      GROUP BY hora
      ORDER BY total DESC
      LIMIT 1`,
      [tenant_id]
    );

    const total = generalStats.rows[0]?.total || 0;
    const unicos = generalStats.rows[0]?.unicos || 0;
    const hora_pico = horaPicoRes.rows[0]?.hora || null;

    return res.status(200).json({ total, unicos, hora_pico });

  } catch (error) {
    console.error('❌ Error en /stats/kpis:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
