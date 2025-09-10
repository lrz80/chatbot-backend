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

    // 🔑 Unimos a sales_intelligence con LATERAL para tomar SOLO la fila más reciente por message_id
    // y evitamos duplicados sin usar DISTINCT ON en messages (que arruina la paginación).
    const params: any[] = [tenantId];
    let canalSQL = '';
    if (canal) {
      canalSQL = `AND LOWER(m.canal) = $2`;
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
        m.timestamp,       -- el front ya usa 'timestamp'
        m.from_number,
        m.emotion,
        si.intencion,
        si.nivel_interes,
        cli.nombre AS nombre_cliente
      FROM messages m
      -- última fila de sales_intelligence por message_id (evita duplicados)
      LEFT JOIN LATERAL (
        SELECT s.intencion, s.nivel_interes
        FROM sales_intelligence s
        WHERE s.tenant_id = m.tenant_id
          AND s.message_id = m.message_id
        ORDER BY s.id DESC
        LIMIT 1
      ) si ON true
      -- nombre del cliente (si hubiera múltiples, toma el más reciente/último id)
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
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const { rows } = await pool.query(
      `
      SELECT LOWER(canal) AS canal, COUNT(*)::int AS total
      FROM messages
      WHERE tenant_id = $1
      GROUP BY LOWER(canal)
      `,
      [tenantId]
    );

    const out: Record<string, number> = {
      whatsapp: 0,
      facebook: 0,
      instagram: 0,
      voice: 0,
    };
    for (const r of rows) {
      if (out[r.canal] !== undefined) out[r.canal] = r.total;
    }
    res.json(out);
  } catch (error) {
    console.error('❌ Error en conteo global:', error);
    res.status(500).json({ error: 'Error al obtener conteo global' });
  }
});

/**
 * GET /api/messages/nuevos?canal=&lastId=123
 * Polling incremental basado en id > lastId, orden ASC.
 */
router.get('/nuevos', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const canal = normCanal(req.query.canal as string);
    const lastId = parseInt((req.query.lastId as string) || '0', 10);
    if (!Number.isFinite(lastId)) return res.status(400).json({ error: 'lastId inválido' });

    const params: any[] = [tenantId, lastId];
    let canalSQL = '';
    if (canal) {
      canalSQL = `AND LOWER(m.canal) = $3`;
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
        AND m.id > $2
        ${canalSQL}
      ORDER BY m.id ASC
      LIMIT 500
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ mensajes: rows });
  } catch (error) {
    console.error('❌ Error en polling nuevos:', error);
    res.status(500).json({ error: 'Error al obtener mensajes nuevos' });
  }
});

export default router;
