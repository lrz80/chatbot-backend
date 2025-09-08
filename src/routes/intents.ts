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

/** ✅ GET: Obtener intenciones (activas) por canal
 *  Soporta ?canal=whatsapp | meta | facebook | instagram | voz
 *  Mantiene los nombres { nombre, ejemplos, respuesta } para no romper tu frontend actual.
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

    // Compat: mismo shape que tenías, pero ahora enviamos id/canal/prioridad/activo por si el FE los quiere usar.
    const intents = rows.map(r => ({
      id: r.id,
      canal: r.canal,
      nombre: r.nombre,
      ejemplos: r.ejemplos,
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
 *  Body esperado (compatible):
 *  {
 *    canal?: 'whatsapp'|'facebook'|'instagram'|'meta'|'voz', // default 'whatsapp'
 *    intents: [{ nombre, ejemplos: string[], respuesta, prioridad?, activo?, idioma? }, ...]
 *  }
 */
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const canal = (req.body?.canal as string) || 'whatsapp';
  const intents = Array.isArray(req.body?.intents) ? req.body.intents : [];

  // Validación mínima
  const validos = intents.filter((i: any) =>
    i?.nombre?.trim() &&
    Array.isArray(i?.ejemplos) &&
    i.ejemplos.length > 0 &&
    i?.respuesta?.trim()
  );

  if (validos.length === 0) {
    return res.status(400).json({ error: 'No se recibieron intenciones válidas' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // UPSERT una por una (NO borramos nada)
    // Requiere la UNIQUE(tenant_id, canal, nombre) del paso 2.A
    for (const it of validos) {
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

/**
 * ✅ PUT /api/intents/:id
 * Body opcional: { canal?, nombre?, ejemplos?, respuesta?, idioma?, activo?, prioridad? }
 * Actualiza SOLO la intención del tenant logueado con ese id.
 */
router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const {
    canal,        // 'whatsapp' | 'facebook' | 'instagram' | 'meta' | 'voz'
    nombre,       // string
    ejemplos,     // string[]
    respuesta,    // string
    idioma,       // string | null
    activo,       // boolean
    prioridad     // number
  } = req.body || {};

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
        Array.isArray(ejemplos) ? ejemplos : null,
        respuesta ?? null,
        typeof idioma === 'undefined' ? null : idioma, // si no viene, lo dejamos como está
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
      ejemplos: r.ejemplos,
      respuesta: r.respuesta,
      idioma: r.idioma,
      prioridad: r.prioridad,
      activo: r.activo,
      created_at: r.created_at,
      updated_at: r.updated_at
    });
  } catch (err) {
    // Probable conflicto por UNIQUE(tenant_id, canal, nombre)
    console.error('❌ PUT /api/intents/:id error:', err);
    return res.status(500).json({ error: 'Error actualizando intención' });
  }
});

/**
 * ✅ DELETE /api/intents/:id
 * Elimina una intención del tenant logueado.
 * (Tu trigger de auditoría guardará snapshot en intenciones_archive)
 */
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
