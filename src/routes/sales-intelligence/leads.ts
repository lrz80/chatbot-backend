// 📁 src/routes/sales-intelligence/leads.ts

import express, { Request, Response } from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

// 📋 GET: Obtener leads de ventas con análisis de scoring
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  const tenant_id = (req as any).user?.tenant_id;
  const { canal, nivel_minimo = 1 } = req.query;

  try {
    let query = `
      SELECT 
        contacto, 
        canal, 
        mensaje, 
        intencion, 
        nivel_interes, 
        fecha,
        CASE
          WHEN nivel_interes >= 4 THEN 'lead_caliente'
          WHEN nivel_interes = 2 OR nivel_interes = 3 THEN 'lead_tibio'
          ELSE 'lead_frio'
        END AS tipo_lead
      FROM sales_intelligence
      WHERE tenant_id = $1 AND nivel_interes >= $2
    `;

    const params: any[] = [tenant_id, nivel_minimo];

    if (canal && canal !== "todos") {
      query += ` AND canal = $3`;
      params.push(canal);
    }

    query += ` ORDER BY fecha DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error en /sales-intelligence/leads:', err);
    res.status(500).json({ error: 'Error al obtener leads' });
  }
});

export default router;
