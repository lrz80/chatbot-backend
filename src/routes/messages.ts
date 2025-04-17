// 📁 src/routes/messages.ts

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

    // Obtener usuario y tenant
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Parámetros de query
    const canal = req.query.canal?.toString() || "";
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    // Construcción dinámica de consulta
    const query = canal
      ? `SELECT id, tenant_id, content, sender, canal, timestamp, from_number FROM messages WHERE tenant_id = $1 AND canal = $2 ORDER BY timestamp ASC LIMIT $3 OFFSET $4`
      : `SELECT id, tenant_id, content, sender, canal, timestamp, from_number FROM messages WHERE tenant_id = $1 ORDER BY timestamp ASC LIMIT $2 OFFSET $3`;

    const values = canal
      ? [tenant.id, canal, limit, offset]
      : [tenant.id, limit, offset];

    const mensajesRes = await pool.query(query, values);

    res.status(200).json({ mensajes: mensajesRes.rows });
  } catch (error) {
    console.error("❌ Error al obtener historial:", error);
    res.status(500).json({ error: "Error al obtener mensajes" });
  }
});

export default router;
