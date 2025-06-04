// src/routes/stats/hora-pico.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

// ⏰ Hora pico de mayor interacción (últimos 7 días)
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const result = await pool.query(
      `
      SELECT
        EXTRACT(HOUR FROM timestamp) AS hora,
        COUNT(*) AS cantidad
      FROM messages
      WHERE tenant_id = $1
        AND sender = 'user'
        AND canal IN ('whatsapp', 'facebook', 'instagram', 'voz')
        AND timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY hora
      ORDER BY cantidad DESC
      LIMIT 1;
      `,
      [tenant_id]
    );    

    if (result.rows.length > 0) {
      res.status(200).json({
        hora_pico: parseInt(result.rows[0].hora),
        cantidad: parseInt(result.rows[0].cantidad),
      });
    } else {
      res.status(200).json({ hora_pico: null, cantidad: 0 });
    }
  } catch (err) {
    console.error('❌ Error al obtener hora pico:', err);
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

export default router;
