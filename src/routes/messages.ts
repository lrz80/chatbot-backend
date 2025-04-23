// 📁 src/routes/messages.ts

import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    // Parámetros de query
    const canal = req.query.canal?.toString() || "";
    const limit = parseInt(req.query.limit as string) || 10;
    const page = parseInt(req.query.page as string) || 1;
    const offset = (page - 1) * limit;

    // Construcción dinámica de consulta
    const query = canal
      ? `SELECT id, tenant_id, content, sender, canal, timestamp, from_number 
         FROM messages 
         WHERE tenant_id = $1 AND canal = $2 
         ORDER BY timestamp DESC 
         LIMIT $3 OFFSET $4`
      : `SELECT id, tenant_id, content, sender, canal, timestamp, from_number 
         FROM messages 
         WHERE tenant_id = $1 
         ORDER BY timestamp DESC 
         LIMIT $2 OFFSET $3`;

    const values = canal
      ? [tenant_id, canal, limit, offset]
      : [tenant_id, limit, offset];

    const mensajesRes = await pool.query(query, values);

    res.status(200).json(mensajesRes.rows);
  } catch (error) {
    console.error("❌ Error al obtener historial:", error);
    res.status(500).json({ error: "Error al obtener mensajes" });
  }
});

export default router;