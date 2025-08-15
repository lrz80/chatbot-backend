// src/routes/follow-up/sentMessages.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import pool from '../../lib/db';

const router = express.Router();

/**
 * GET /follow-up/sent-messages
 * Query params:
 *  - status: "sent" | "pending" | "all"  (default: "sent")
 *  - channel: "whatsapp" | "facebook" | ... (opcional)
 *  - q: texto a buscar en contacto/contenido (opcional)
 *  - page: número de página (default 1)
 *  - limit: tamaño de página (1..200, default 100)
 */
router.get('/', authenticateUser, async (req, res) => {
  try {
    const tenant_id = (req as any).user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const { status = 'sent', channel, q, page: pageQ, limit: limitQ } = req.query as any;

    const limit = Math.max(1, Math.min(Number(limitQ) || 100, 200));
    const page = Math.max(1, Number(pageQ) || 1);
    const offset = (page - 1) * limit;

    const where: string[] = ['tenant_id = $1'];
    const params: any[] = [tenant_id];

    // Filtro de estado
    if (status === 'sent') where.push('enviado = true');
    else if (status === 'pending') where.push('enviado = false');
    // status = "all" => sin filtro

    // Filtro de canal
    if (channel && typeof channel === 'string') {
      params.push(channel);
      where.push(`canal = $${params.length}`);
    }

    // Búsqueda simple
    if (q && typeof q === 'string' && q.trim().length > 0) {
      const pat = `%${q.trim()}%`;
      params.push(pat, pat);
      where.push(`(contacto ILIKE $${params.length - 1} OR contenido ILIKE $${params.length})`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Total para paginación
    const countSql = `SELECT COUNT(*)::int AS total FROM mensajes_programados ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows[0]?.total ?? 0;

    // Orden:
    //  - enviados: por sent_at (si no hubiera, cae a fecha_envio), luego id DESC
    //  - pendientes: por fecha_envio DESC (más próximos primero), luego id DESC
    const orderSql = `
      ORDER BY
        CASE
          WHEN enviado THEN COALESCE(sent_at, fecha_envio)
          ELSE fecha_envio
        END DESC,
        id DESC
    `;

    params.push(limit, offset);
    const selectSql = `
      SELECT id, canal, contacto, contenido, fecha_envio, enviado, sent_at
      FROM mensajes_programados
      ${whereSql}
      ${orderSql}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows: items } = await pool.query(selectSql, params);

    res.status(200).json({
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('❌ Error en GET /follow-up/sent-messages:', error);
    res.status(500).json({ error: 'Error al obtener mensajes de seguimiento' });
  }
});

export default router;
