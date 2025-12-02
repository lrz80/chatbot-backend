// src/routes/messages.ts
import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

function normCanal(c?: string) {
  return (c || '').trim().toLowerCase();
}

/**
 * GET /api/messages?canal=&page=1&limit=10
 * Lista paginada por recencia global.
 */
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = normCanal(req.query.canal as string);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '10', 10), 1), 100);
    const page = Math.max(parseInt((req.query.page as string) || '1', 10), 1);
    const offset = (page - 1) * limit;

    const params: any[] = [tenantId];
    let canalSQL = '';
    if (canal) {
      // ⚠️ Si m.canal ya se guarda en minúsculas, mejor: m.canal = $2 (sin LOWER()) para usar índice
      canalSQL = `AND m.canal = $2`;
      params.push(canal);
    }
    params.push(limit, offset);

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
      LEFT JOIN LATERAL (
        SELECT s.intencion, s.nivel_interes
        FROM sales_intelligence s
        WHERE s.tenant_id = m.tenant_id
          AND s.message_id = m.message_id
        ORDER BY s.id DESC
        LIMIT 1
      ) si ON true
      LEFT JOIN LATERAL (
        SELECT c.nombre
        FROM clientes c
        WHERE c.tenant_id = m.tenant_id
          AND c.contacto = m.from_number
        ORDER BY c.id DESC
        LIMIT 1
      ) cli ON true
      WHERE m.tenant_id = $1
        ${canalSQL}
      ORDER BY m.timestamp DESC, m.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await pool.query(sql, params);
    res.status(200).json({ mensajes: rows });
  } catch (error) {
    console.error('❌ Error al obtener historial:', error);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

/**
 * GET /api/messages/conteo
 * Totales por canal para los badges del front.
 */
router.get('/conteo', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: 'Tenant no autenticado' });
    }

    const { rows } = await pool.query(
      `
      SELECT
        CASE
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%whatsapp%'
            OR LOWER(COALESCE(m.canal, '')) LIKE 'wa%' THEN 'whatsapp'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%facebook%'
            OR LOWER(COALESCE(m.canal, '')) = 'fb' THEN 'facebook'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%instagram%'
            OR LOWER(COALESCE(m.canal, '')) = 'ig' THEN 'instagram'
          WHEN LOWER(COALESCE(m.canal, '')) LIKE '%voz%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%voice%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%llamada%'
            OR LOWER(COALESCE(m.canal, '')) LIKE '%telefono%' THEN 'voice'
          ELSE TRIM(LOWER(COALESCE(m.canal, '')))
        END AS canal,
        COUNT(*)::int AS total
      FROM messages m
      WHERE m.tenant_id = $1
      GROUP BY 1
      `,
      [tenantId]
    );

    const conteo: Record<string, number> = {
      whatsapp: 0,
      facebook: 0,
      instagram: 0,
      voice: 0,
    };

    for (const r of rows) {
      const canal = (r.canal || '').toString();
      if (conteo[canal] !== undefined) {
        conteo[canal] = r.total;
      }
    }

    console.log('📊 /api/messages/conteo =>', conteo);

    return res.json(conteo);
  } catch (error) {
    console.error('❌ Error en conteo global:', error);
    return res.status(500).json({ error: 'Error al obtener conteo global' });
  }
});

export default router;
