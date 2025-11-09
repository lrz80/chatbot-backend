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

// ✅ POST: Guardar/actualizar (UPSERT) respetando canal
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const intents = Array.isArray(req.body?.intents) ? req.body.intents : [];
  const canalGlobal = (req.body?.canal as string) || (req.query?.canal as string) || ''; // ✅ usa body o query
  const ref = (req.headers['referer'] as string) || '';                                  // ✅ referer

  const validos = intents.filter((i: any) =>
    i?.nombre?.trim() && Array.isArray(i?.ejemplos) && i.ejemplos.length > 0 && i?.respuesta?.trim()
  );
  if (validos.length === 0) return res.status(400).json({ error: 'No se recibieron intenciones válidas' });

  const ALLOWED = new Set(['whatsapp','facebook','instagram','meta','voz']);
  const resolveCanal = (it: any) => {
    let c = (it?.canal || canalGlobal || '').toLowerCase();

    // 🔎 inferir por referer si no vino
    if (!c) {
      if (ref.includes('/dashboard/meta-config')) c = 'meta';
      else c = 'whatsapp'; // fallback
    }
    // Unificar FB/IG bajo meta si tu contenido es único para Meta
    if (c === 'facebook' || c === 'instagram') c = 'meta';
    if (!ALLOWED.has(c)) c = 'whatsapp';
    return c;
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const it of validos) {
      const canal = resolveCanal(it);  // 🔐 aquí se decide
      const nombre = it.nombre.trim();
      const ejemplos: string[] = it.ejemplos;
      const respuesta = it.respuesta.trim();
      const prioridad = Number(it.prioridad ?? 100);
      const activo = typeof it.activo === 'boolean' ? it.activo : true;
      const idioma = it.idioma ?? null;

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
        [tenantId, canal, nombre, ejemplos, respuesta, idioma, activo, prioridad]
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

router.put('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  // canal explícito en query
  let canalQ = String((req.query?.canal as string) || '').trim().toLowerCase();
  const ALLOWED = new Set(['whatsapp','facebook','instagram','meta','voz']);
  if (!ALLOWED.has(canalQ)) canalQ = 'whatsapp';

  // si en algún momento guardaste FB/IG por separado, puedes querer expandir:
  // const canales = canalesDe(canalQ).map(c => c.toLowerCase());
  const canales = [canalQ]; // ← si quieres borrar también facebook/instagram cuando canalQ=meta, cambia por la línea de arriba

  const raw = req.body?.intents;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'intents debe ser un arreglo' });

  const intents = raw
    .map((it: any) => ({
      nombre: String(it?.nombre || '').trim(),
      ejemplos: toEjemplosArray(it?.ejemplos),
      respuesta: String(it?.respuesta || '').trim(),
      idioma: typeof it?.idioma === 'string' ? it.idioma : null,
      activo: typeof it?.activo === 'boolean' ? it.activo : true,
      prioridad: Number.isFinite(it?.prioridad) ? Number(it.prioridad) : 100,
    }))
    .filter(it => it.nombre && it.ejemplos.length && it.respuesta);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 🔎 log de diagnóstico (puedes dejarlo unos días)
    console.log('🧹 intents.put DELETE for tenant:', tenantId, 'canales:', canales);

    // 1) borrar robusto por canal (case-insensitive y sin espacios)
    const del = await client.query(
      `DELETE FROM intenciones 
        WHERE tenant_id = $1 
          AND LOWER(TRIM(canal)) = ANY($2)`,
      [tenantId, canales]
    );

    // 2) insertar nuevas
    for (const it of intents) {
      await client.query(
        `INSERT INTO intenciones 
           (tenant_id, canal, nombre, ejemplos, respuesta, idioma, activo, prioridad)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, canalQ, it.nombre, it.ejemplos, it.respuesta, it.idioma, it.activo, it.prioridad]
      );
    }

    await client.query('COMMIT');

    return res.json({ ok: true, deleted: del.rowCount, inserted: intents.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ PUT /api/intents error:', err);
    return res.status(500).json({ error: 'Error guardando intenciones' });
  } finally {
    client.release();
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
