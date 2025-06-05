import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

// 👤 Usuarios únicos por día (últimos 7 días)
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const result = await pool.query(
      `
      SELECT
        DATE(timestamp) AS dia,
        COUNT(DISTINCT from_number) AS count
      FROM messages
      WHERE tenant_id = $1
        AND role = 'user'
        AND canal IN ('whatsapp', 'facebook', 'instagram', 'voz')
        AND timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY dia
      ORDER BY dia ASC;
      `,
      [tenant_id]
    );    

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('❌ Error al obtener usuarios únicos por día:', err);
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

export default router;
