import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  const tenant_id = (req as any).user?.tenant_id;

  if (!tenant_id) {
    return res.status(400).json({ error: 'Tenant ID no encontrado' });
  }

  try {
    const result = await pool.query(
      `
      SELECT LOWER(word) AS palabra, COUNT(*) AS cantidad
      FROM (
        SELECT unnest(string_to_array(content, ' ')) AS word
        FROM messages
        WHERE tenant_id = $1 AND role = 'user'
      ) AS palabras
      WHERE LENGTH(word) > 2
      GROUP BY palabra
      ORDER BY cantidad DESC
      LIMIT 10
      `,
      [tenant_id]
    );

    const keywords = result.rows.map((row) => [row.palabra, parseInt(row.cantidad)]);
    res.status(200).json({ keywords });
  } catch (err) {
    console.error('❌ Error al generar keywords dinámicamente:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
