// src/routes/messages-nuevos.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { validate as isUuid } from "uuid";

const router = Router();

const norm = (s?: string) => (s || "").trim().toLowerCase();

/**
 * Filtro canonical por canal (misma semántica que /api/messages/conteo)
 * - whatsapp: 'whatsapp', 'whatsapp_out', 'wa...', etc
 * - facebook: 'facebook', 'fb'
 * - instagram: 'instagram', 'ig'
 * - voice: 'voz', 'voice', 'llamada', 'telefono', etc
 */
function buildCanalFilterSQL(paramIndex: number) {
  // paramIndex apunta al $N donde viene el canal canonical (texto)
  const p = `$${paramIndex}::text`;

  return `
    AND (
      ${p} = ''
      OR (
        (${p} = 'whatsapp' AND (
          LOWER(COALESCE(m.canal,'')) LIKE '%whatsapp%'
          OR LOWER(COALESCE(m.canal,'')) LIKE 'wa%'
        ))
        OR (${p} = 'facebook' AND (
          LOWER(COALESCE(m.canal,'')) LIKE '%facebook%'
          OR LOWER(COALESCE(m.canal,'')) = 'fb'
        ))
        OR (${p} = 'instagram' AND (
          LOWER(COALESCE(m.canal,'')) LIKE '%instagram%'
          OR LOWER(COALESCE(m.canal,'')) = 'ig'
        ))
        OR (${p} = 'voice' AND (
          LOWER(COALESCE(m.canal,'')) LIKE '%voz%'
          OR LOWER(COALESCE(m.canal,'')) LIKE '%voice%'
          OR LOWER(COALESCE(m.canal,'')) LIKE '%llamada%'
          OR LOWER(COALESCE(m.canal,'')) LIKE '%telefono%'
        ))
        OR (TRIM(LOWER(COALESCE(m.canal,''))) = ${p})
      )
    )
  `;
}

/**
 * GET /api/messages/nuevos?canal=&lastTs=<ISO>&lastId=<uuid>
 *
 * ✅ Cursor correcto: (timestamp, id)
 * - Si lastTs viene: trae mensajes estrictamente posteriores a lastTs,
 *   con desempate por id cuando timestamp es igual.
 * - Si lastTs NO viene: trae los más recientes (hasta 500) para bootstrap.
 *
 * Nota: lastId debe ser UUID si se envía.
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id as string | undefined;
    if (!tenantId) return res.status(401).json({ error: "Tenant no autenticado" });

    const canal = norm(req.query.canal as string);

    // Nuevo cursor recomendado
    const lastTsRaw = (req.query.lastTs as string) || null;

    // Compatibilidad (desempate / cursor)
    const lastIdRaw = (req.query.lastId as string) || null;

    // lastId si viene, debe ser UUID
    if (lastIdRaw && !isUuid(lastIdRaw)) {
      return res.status(400).json({ error: "lastId inválido (UUID esperado)" });
    }

    // lastTs si viene, debe parsear a fecha válida
    let lastTs: string | null = null;
    if (lastTsRaw) {
      const dt = new Date(lastTsRaw);
      if (Number.isNaN(dt.getTime())) {
        return res.status(400).json({ error: "lastTs inválido (ISO esperado)" });
      }
      // guardamos el ISO normalizado
      lastTs = dt.toISOString();
    }

    // Params:
    // $1 tenantId
    // $2 lastTs (timestamptz) nullable
    // $3 lastId (uuid) nullable
    // $4 canal (text) (canonical)
    const params: any[] = [tenantId, lastTs, lastIdRaw, canal];

    const canalSQL = buildCanalFilterSQL(4);

    // Si NO hay lastTs, devolvemos los más recientes para bootstrap
    // (ordenados DESC y luego el front los mergea). Si quieres, puedes
    // ordenarlos ASC, pero bootstrap suele ser mejor DESC.
    const bootstrapMode = !lastTs;

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
        ${canalSQL}
        AND (
          $2::timestamptz IS NULL
          OR (m.timestamp > $2::timestamptz)
          OR (
            m.timestamp = $2::timestamptz
            AND $3::uuid IS NOT NULL
            AND m.id > $3::uuid
          )
        )
      ORDER BY
        ${bootstrapMode ? "m.timestamp DESC, m.id DESC" : "m.timestamp ASC, m.id ASC"}
      LIMIT 500;
    `;

    const { rows } = await pool.query(sql, params);
    return res.status(200).json({ mensajes: rows });
  } catch (error) {
    console.error("❌ Error al obtener mensajes nuevos:", error);
    return res.status(500).json({ error: "Error al obtener nuevos mensajes" });
  }
});

export default router;