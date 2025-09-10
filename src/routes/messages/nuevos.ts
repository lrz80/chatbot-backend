// src/routes/messages-nuevos.ts
import { Router, Request, Response } from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';
import { validate as isUuid } from 'uuid';

const router = Router();
const norm = (s?: string) => (s || '').trim().toLowerCase();

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = norm(req.query.canal as string);
    const lastIdRaw = (req.query.lastId as string) || '';

    // 🔑 Resolver umbral de ID (numérico) aunque nos manden un UUID
    let idThreshold = 0;
    if (lastIdRaw) {
      if (/^\d+$/.test(lastIdRaw)) {
        idThreshold = parseInt(lastIdRaw, 10);
      } else if (isUuid(lastIdRaw)) {
        const r = await pool.query(
          `SELECT COALESCE(MAX(id), 0) AS id
           FROM messages
           WHERE tenant_id = $1 AND message_id = $2`,
          [tenantId, lastIdRaw]
        );
        idThreshold = Number(r.rows?.[0]?.id || 0);
      } else {
        return res.status(400).json({ error: 'lastId inválido' });
      }
    }

    const params: any[] = [tenantId, idThreshold];
    let canalSQL = '';
    if (canal) {
      canalSQL = 'AND LOWER(m.canal) = $3';
      params.push(canal);
    }

    const sql = `
      SELECT
        m.id,
        m.message_id,
        m.tenant_id,
        m.content,
        m.role,
        m.canal,
        m.timestamp,
        m.from_number,
        m.emotion,
        si.intencion,
        si.nivel_interes,
        cli.nombre AS nombre_cliente
      FROM messages m
      -- última fila de sales_intelligence por message_id
      LEFT JOIN LATERAL (
        SELECT s.intencion, s.nivel_interes
        FROM sales_intelligence s
        WHERE s.tenant_id = m.tenant_id
          AND s.message_id = m.message_id
        ORDER BY s.id DESC
        LIMIT 1
      ) si ON true
      -- nombre del cliente (último registro)
      LEFT JOIN LATERAL (
        SELECT c.nombre
        FROM clientes c
        WHERE c.tenant_id = m.tenant_id
          AND c.contacto = m.from_number
        ORDER BY c.id DESC
        LIMIT 1
      ) cli ON true
      WHERE m.tenant_id = $1
        AND m.id > $2
        ${canalSQL}
      ORDER BY m.id ASC
      LIMIT 500;
    `;

    const { rows } = await pool.query(sql, params);
    return res.status(200).json({ mensajes: rows });
  } catch (error) {
    console.error('❌ Error al obtener mensajes nuevos:', error);
    return res.status(500).json({ error: 'Error al obtener nuevos mensajes' });
  }
});

export default router;
