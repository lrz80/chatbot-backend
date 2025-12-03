// src/routes/messages/conteo.ts
import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

// GET /api/messages/conteo
router.get('/', authenticateUser, async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `
      SELECT
        CASE
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%whatsapp%'
            OR LOWER(COALESCE(m.canal, '')) LIKE 'wa%' THEN 'whatsapp'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%facebook%'
            OR LOWER(COALESCE(m.canal, '')) = 'fb' THEN 'facebook'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%instagram%'
            OR LOWER(COALESCE(m.canal, '')) = 'ig' THEN 'instagram'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%voz%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%voice%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%llamada%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%telefono%' THEN 'voice'
          ELSE TRIM(LOWER(COALESCE(m.canal, '')))
        END AS canal,
        COUNT(*)::int AS total
      FROM messages m
      WHERE m.tenant_id = $1
        AND m.role = 'assistant'   -- 👈 SOLO respuestas del bot
      GROUP BY 1
      `,
      [tenantId]
    );

    const conteo: Record<string, number> = {
      whatsapp: 0,
      facebook: 0,
      instagram: 0,
      voice: 0,
    };

    for (const r of rows) {
      const canal = (r.canal || '').toString();
      if (conteo[canal] !== undefined) {
        conteo[canal] = r.total;
      }
    }

    console.log('📊 /api/messages/conteo (subrouter) =>', conteo);

    return res.json(conteo);
  } catch (err) {
    console.error('❌ Error al obtener conteo global:', err);
    return res.status(500).json({ error: 'Error al obtener conteo' });
  }
});

export default router;
