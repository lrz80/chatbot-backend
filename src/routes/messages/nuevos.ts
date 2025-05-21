// 📁 src/routes/messages-nuevos.ts

import { Router, Request, Response } from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = Router();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = req.query.canal?.toString() || "";
    const lastId = parseInt(req.query.lastId as string) || 0;

    const query = canal
      ? `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 AND m.canal = $2 AND m.id > $3
         ORDER BY m.id ASC
         LIMIT 20`
      : `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 AND m.id > $2
         ORDER BY m.id ASC
         LIMIT 20`;

    const values = canal
      ? [tenant_id, canal, lastId]
      : [tenant_id, lastId];

    const mensajesRes = await pool.query(query, values);

    res.status(200).json({ mensajes: mensajesRes.rows }); // formato igual que la otra ruta
  } catch (error) {
    console.error("❌ Error al obtener mensajes nuevos:", error);
    res.status(500).json({ error: "Error al obtener nuevos mensajes" });
  }
});

export default router;
