// 📁 src/routes/messages-nuevos.ts
import { Router, Request, Response } from 'express';
import { authenticateUser } from '../../middleware/auth'; 
import pool from '../../lib/db';                   

const router = Router();

const normalize = (s?: string) => (s || '').trim().toLowerCase();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = normalize(req.query.canal as string);
    const lastId = Number(req.query.lastId ?? 0);     // 👈 numérico
    if (!Number.isFinite(lastId) || lastId < 0) {
      return res.status(400).json({ error: 'lastId inválido' });
    }

    const params: any[] = [tenantId, lastId];
    let canalSQL = '';
    if (canal) {
      canalSQL = 'AND LOWER(m.canal) = $3';
      params.push(canal);
    }

    const sql = `
      SELECT
        m.id,
        m.tenant_id,
        m.message_id,
        m.content,
        m.role,
        m.canal,
        m.timestamp,
        m.from_number,
        m.emotion,
        si.intencion,
        si.nivel_interes
      FROM messages m
      -- toma la última fila de sales_intelligence por message_id
      LEFT JOIN LATERAL (
        SELECT s.intencion, s.nivel_interes
        FROM sales_intelligence s
        WHERE s.tenant_id = m.tenant_id
          AND s.message_id = m.message_id
        ORDER BY s.id DESC
        LIMIT 1
      ) si ON true
      WHERE m.tenant_id = $1
        AND m.id > $2
        ${canalSQL}
      ORDER BY m.id ASC
      LIMIT 500;      -- puedes bajar a 100/200 si quieres
    `;

    const { rows } = await pool.query(sql, params);
    return res.status(200).json({ mensajes: rows });
  } catch (error) {
    console.error('❌ Error al obtener mensajes nuevos:', error);
    return res.status(500).json({ error: 'Error al obtener nuevos mensajes' });
  }
});

export default router;
