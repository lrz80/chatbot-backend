import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET: Obtener intenciones
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    const result = await pool.query(
      'SELECT nombre, ejemplos, respuesta FROM intents WHERE tenant_id = $1',
      [tenantId]
    );

    const intents = result.rows.map((i) => ({
      nombre: i.nombre,
      ejemplos: i.ejemplos.split('||'),
      respuesta: i.respuesta,
    }));

    return res.status(200).json(intents);
  } catch (err) {
    console.error('❌ Error al obtener intenciones:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// POST: Guardar intenciones
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const { intents } = req.body;

    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [decoded.uid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Limpiar anteriores
    await pool.query('DELETE FROM intents WHERE tenant_id = $1', [tenantId]);

    for (const intent of intents) {
      await pool.query(
        'INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta) VALUES ($1, $2, $3, $4)',
        [tenantId, intent.nombre, intent.ejemplos.join('||'), intent.respuesta]
      );
    }

    return res.status(200).json({ message: 'Intenciones actualizadas' });
  } catch (err) {
    console.error('❌ Error al guardar intenciones:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
