import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

// 🧠 Intenciones de venta por día (últimos 7 días)
router.get('/', authenticateUser, async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const result = await pool.query(
      `
      SELECT
        DATE(fecha) AS dia,
        COUNT(*) AS count
      FROM sales_intelligence
      WHERE tenant_id = $1
        AND fecha >= NOW() - INTERVAL '7 days'
        AND LOWER(intencion) IN ('comprar', 'pagar', 'precio', 'reservar', 'agendar')
        AND nivel_interes >= 2
      GROUP BY dia
      ORDER BY dia ASC;
      `,
      [tenant_id]
    );    

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('❌ Error al obtener intenciones por día:', err);
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

export default router;
