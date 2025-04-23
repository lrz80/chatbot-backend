// 📁 src/routes/intents.ts

import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

// ✅ GET: Obtener intenciones
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;

  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const result = await pool.query(
      'SELECT nombre, ejemplos, respuesta FROM intents WHERE tenant_id = $1',
      [tenantId]
    );

    const intents = result.rows.map((i) => ({
      nombre: i.nombre,
      ejemplos: i.ejemplos, // ya viene como array desde Postgres
      respuesta: i.respuesta,
    }));

    return res.status(200).json(intents);
  } catch (err) {
    console.error('❌ Error al obtener intenciones:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ✅ POST: Guardar intenciones
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;

  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  try {
    const { intents } = req.body;

    await pool.query('DELETE FROM intents WHERE tenant_id = $1', [tenantId]);

    for (const intent of intents) {
      const ejemplosArray = Array.isArray(intent.ejemplos) ? intent.ejemplos : [];

      await pool.query(
        'INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta) VALUES ($1, $2, $3, $4)',
        [tenantId, intent.nombre, ejemplosArray, intent.respuesta]
      );
    }

    return res.status(200).json({ message: 'Intenciones actualizadas' });
  } catch (err) {
    console.error('❌ Error al guardar intenciones:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
