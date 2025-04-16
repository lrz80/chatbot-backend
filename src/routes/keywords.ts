// src/routes/keywords.ts
import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    // Busca el tenant por admin_uid
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE admin_uid = $1', [uid]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const result = await pool.query(
      'SELECT palabra, cantidad FROM keywords WHERE tenant_id = $1 ORDER BY cantidad DESC LIMIT 10',
      [tenant.id]
    );

    const keywords = result.rows.map((row) => [row.palabra, row.cantidad]);

    res.json({ keywords });
  } catch (err) {
    console.error('❌ Error al obtener keywords:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;

