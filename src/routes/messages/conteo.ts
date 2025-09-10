// src/routes/messages/conteo.ts
import express from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

// GET /api/messages/conteo
router.get('/', authenticateUser, async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const { rows } = await pool.query(
      `
      SELECT LOWER(TRIM(m.canal)) AS canal,
             COUNT(DISTINCT m.message_id)::int AS total
      FROM messages m
      WHERE m.tenant_id = $1
        AND LOWER(COALESCE(m.role, '')) = 'user'   -- solo mensajes del cliente
      GROUP BY 1
      `,
      [tenantId]
    );

    // Lo que el front espera:
    const conteo: Record<string, number> = {
      whatsapp: 0,
      facebook: 0,
      instagram: 0,
      voice: 0,
    };

    for (const r of rows) {
      const c = (r.canal || '').toString();
      if (c === 'voice' || c === 'voz') conteo.voice = r.total;
      else if (conteo[c] !== undefined) conteo[c] = r.total;
    }

    res.json(conteo);
  } catch (err) {
    console.error('❌ Error al obtener conteo global:', err);
    res.status(500).json({ error: 'Error al obtener conteo' });
  }
});

export default router;
