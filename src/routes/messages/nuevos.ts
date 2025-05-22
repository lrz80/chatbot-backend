// 📁 src/routes/messages-nuevos.ts

import { Router, Request, Response } from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';
import { validate as validateUuid } from 'uuid';

const router = Router();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = req.query.canal?.toString() || "";
    const lastId = req.query.lastId?.toString();

    // 🛡️ Validar que lastId sea un UUID válido o null
    if (lastId && !validateUuid(lastId)) {
      return res.status(400).json({ error: 'ID inválido (UUID esperado)' });
    }

    const query = canal
      ? `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 AND m.canal = $2 ${lastId ? 'AND m.id > $3' : ''}
         ORDER BY m.id ASC
         LIMIT 20`
      : `SELECT 
           m.id, m.tenant_id, m.content, m.sender, m.canal, m.timestamp, m.from_number, m.emotion,
           s.intencion, s.nivel_interes
         FROM messages m
         LEFT JOIN sales_intelligence s
           ON m.from_number = s.contacto AND m.content = s.mensaje
         WHERE m.tenant_id = $1 ${lastId ? 'AND m.id > $2' : ''}
         ORDER BY m.id ASC
         LIMIT 20`;

    const values = canal
      ? lastId ? [tenant_id, canal, lastId] : [tenant_id, canal]
      : lastId ? [tenant_id, lastId] : [tenant_id];

    const mensajesRes = await pool.query(query, values);

    res.status(200).json({ mensajes: mensajesRes.rows });
  } catch (error) {
    console.error("❌ Error al obtener mensajes nuevos:", error);
    res.status(500).json({ error: "Error al obtener nuevos mensajes" });
  }
});

export default router;
