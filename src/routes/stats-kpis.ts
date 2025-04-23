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

    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT phone) AS unicos,
              EXTRACT(HOUR FROM created_at) AS hora_pico
       FROM interactions
       WHERE tenant_id = $1
       GROUP BY hora_pico
       ORDER BY COUNT(*) DESC
       LIMIT 1`,
      [tenant_id]
    );

    console.log("📊 Resultados KPI:", result.rows);

    const row = result.rows[0] || {
      total: 0,
      usuarios: 0,
      hora_pico: null,
    };

    console.log("✅ Fila seleccionada:", row);

    const { total, usuarios, hora_pico } = row;

    return res.status(200).json({ total, usuarios, hora_pico });
  } catch (error) {
    console.error('❌ Error en /stats/kpis:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
