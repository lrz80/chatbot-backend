// 📁 src/routes/intents.ts
import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

/** Unifica 'meta' => ['meta','facebook','instagram'] */
function canalesDe(canal?: string) {
  const c = (canal || 'whatsapp').toLowerCase();
  return c === 'meta' ? ['meta', 'facebook', 'instagram'] : [c];
}

/** Normaliza "ejemplos" a string[] desde:
 * - text[] de Postgres (array)
 * - JSON: '["a","b"]'
 * - PG array: '{a,b,"c d"}'
 * - CSV/; / | : 'a, b; c | d'
 * - null/undefined -> []
 */
function parseEjemplos(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.map(String).map(s => s.trim()).filter(Boolean);
  }
  if (typeof val !== 'string') return [];

  const s = val.trim();
  // JSON array
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr)
        ? arr.map(String).map(x => x.trim()).filter(Boolean)
        : [];
    } catch { /* ignore */ }
  }
  // Postgres array literal {a,b,"c d"}
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    const parts = inner.match(/"([^"]*)"|'([^']*)'|[^,]+/g) || [];
    return parts.map(p => p.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  }
  // CSV / ; / |
  return s.split(/[;,|]/g).map(x => x.trim()).filter(Boolean);
}

/** Asegura array y deduplica preservando orden */
function toEjemplosArray(val: unknown): string[] {
  const arr = parseEjemplos(val);
  return [...new Set(arr)];
}

type NormalizedIntent = {
  nombre: string;
  ejemplos: string[];
  respuesta: string;
  prioridad: number;
  activo: boolean;
  idioma: string | null;
};

/** ✅ GET: Obtener intenciones (activas) por canal
 *  Soporta ?canal=whatsapp | meta | facebook | instagram | voz
 */
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const canales = canalesDe(req.query.canal as string | undefined);

  try {
    const { rows } = await pool.query(
      `SELECT id, canal, nombre, ejemplos, respuesta, idioma, prioridad, activo
         FROM intenciones
        WHERE tenant_id = $1
          AND canal = ANY($2)
          AND activo = TRUE
        ORDER BY prioridad ASC, id ASC`,
      [tenantId, canales]
    );

    const intents = rows.map(r => ({
      id: r.id,
      canal: r.canal,
      nombre: r.nombre,
      ejemplos: toEjemplosArray(r.ejemplos), // 👈 asegura array
      respuesta: r.respuesta,
      idioma: r.idioma,
      prioridad: r.prioridad,
      activo: r.activo,
    }));

    return res.status(200).json(intents);
  } catch (err) {
    console.error('❌ GET /api/intents error:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

/** ✅ POST: Guardar/actualizar en bloque con UPSERT (sin borrar todo)
 *  Body:
 *  {
 *    canal?: 'whatsapp'|'facebook'|'instagram'|'meta'|'voz', // default 'whatsapp'
 *    intents: [{ nombre, ejemplos, respuesta, prioridad?, activo?, idioma? }, ...]
 *  }
 */
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const canal = (req.body?.canal as string) || 'whatsapp';
const rawIntents: unknown[] = Array.isArray(req.body?.intents) ? req.body.intents : [];

// Normaliza primero (y tipa el resultado)
const normalizados: NormalizedIntent[] = (rawIntents as any[]).map(
  (i: any): NormalizedIntent => ({
    nombre: (i?.nombre || '').toString().trim(),
    ejemplos: toEjemplosArray(i?.ejemplos), // siempre array
    respuesta: (i?.respuesta || '').toString().trim(),
    prioridad: Number(i?.prioridad ?? 100),
    activo: typeof i?.activo === 'boolean' ? i.activo : true,
    idioma: i?.idioma ?? null
  })
);

// Validación con tipo inferido
const validos: NormalizedIntent[] = normalizados.filter(
  (i: NormalizedIntent) => i.nombre && i.ejemplos.length > 0 && i.respuesta
);

if (validos.length === 0) {
  return res.status(400).json({ error: 'No se recibieron intenciones válidas' });
}

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const it of validos) {
      await client.query(
        `INSERT INTO intenciones (tenant_id, canal, nombre, ejemplos, respuesta, idioma, activo, prioridad)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, canal, nombre)
           DO UPDATE SET
             ejemplos  = EXCLUDED.ejemplos,
             respuesta = EXCLUDED.respuesta,
             idioma    = EXCLUDED.idioma,
             activo    = EXCLUDED.activo,
             prioridad = EXCLUDED.prioridad,
             updated_at = NOW()`,
        [tenantId, canal, it.nombre, it.ejemplos, it.respuesta, it.idioma, it.activo, it.prioridad]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Intenciones guardadas/actualizadas correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ POST /api/intents error:', err);
    return res.status(500).json({ error: 'Error interno' });
  } finally {
    client.release();
  }
});

/** ✅ PUT /api/intents/:id
 *  Body opcional: { canal?, nombre?, ejemplos?, respuesta?, idioma?, activo?, prioridad? }
 */
router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const {
    canal, nombre, ejemplos, respuesta, idioma, activo, prioridad
  } = req.body || {};

  const ejemplosParsed =
    typeof ejemplos === 'undefined' ? null : toEjemplosArray(ejemplos); // 👈

  try {
    const { rows } = await pool.query(
      `UPDATE intenciones
          SET canal      = COALESCE($1, canal),
              nombre     = COALESCE($2, nombre),
              ejemplos   = COALESCE($3, ejemplos),
              respuesta  = COALESCE($4, respuesta),
              idioma     = $5,
              activo     = COALESCE($6, activo),
              prioridad  = COALESCE($7, prioridad),
              updated_at = NOW()
        WHERE id = $8 AND tenant_id = $9
        RETURNING id, canal, nombre, ejemplos, respuesta, idioma, prioridad, activo, created_at, updated_at`,
      [
        canal ?? null,
        nombre ?? null,
        ejemplosParsed, // 👈 asegura array o null (no cambia)
        respuesta ?? null,
        typeof idioma === 'undefined' ? null : idioma,
        typeof activo === 'boolean' ? activo : null,
        typeof prioridad === 'number' ? prioridad : null,
        id,
        tenantId
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Intención no encontrada' });

    const r = rows[0];
    return res.json({
      id: r.id,
      canal: r.canal,
      nombre: r.nombre,
      ejemplos: toEjemplosArray(r.ejemplos), // 👈 por si el driver devuelve string
      respuesta: r.respuesta,
      idioma: r.idioma,
      prioridad: r.prioridad,
      activo: r.activo,
      created_at: r.created_at,
      updated_at: r.updated_at
    });
  } catch (err) {
    console.error('❌ PUT /api/intents/:id error:', err);
    return res.status(500).json({ error: 'Error actualizando intención' });
  }
});

/** ✅ DELETE /api/intents/:id */
router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM intenciones WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Intención no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/intents/:id error:', err);
    return res.status(500).json({ error: 'Error eliminando intención' });
  }
});

export default router;
