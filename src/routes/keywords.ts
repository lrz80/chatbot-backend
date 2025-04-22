import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

// ✅ Esta ruta ahora usa el middleware para obtener tenant_id
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  const { tenant_id } = (req as any).user;

  if (!tenant_id) {
    return res.status(400).json({ error: 'Tenant ID no encontrado' });
  }

  try {
    const result = await pool.query(
      'SELECT palabra, cantidad FROM keywords WHERE tenant_id = $1 ORDER BY cantidad DESC LIMIT 10',
      [tenant_id]
    );

    const keywords = result.rows.map((row) => [row.palabra, row.cantidad]);

    res.json({ keywords });
  } catch (err) {
    console.error('❌ Error al obtener keywords:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
