// 📁 src/routes/messages.ts

import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET /api/messages - Historial de mensajes para el tenant actual
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Buscar tenant del usuario
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const mensajes = await pool.query(
      `SELECT * FROM messages WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT 50`,
      [tenant.id]
    );

    res.status(200).json({ mensajes: mensajes.rows });
  } catch (error) {
    console.error('❌ Error al obtener historial:', error);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

export default router;
