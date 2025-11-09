import { Router, Request, Response } from 'express';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = Router();

function canalesDe(canal?: string) {
  const c = (canal || 'whatsapp').toLowerCase();
  return c === 'meta' ? ['meta', 'facebook', 'instagram'] : [c];
}

router.get('/', authenticateUser, async (req, res) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const canales = canalesDe(req.query.canal as string | undefined);

  try {
    const { rows } = await pool.query(
      `SELECT id, canal, nombre, ejemplos, respuesta, idioma, prioridad, activo
       FROM intenciones
       WHERE tenant_id = $1 AND canal = ANY($2)
       ORDER BY prioridad ASC, id ASC`,
      [tenantId, canales]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/intents error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

  const canal = (req.query.canal as string)?.toLowerCase() || 'whatsapp';
  const intents = Array.isArray(req.body?.intents) ? req.body.intents : [];

  if (!intents.length) return res.status(400).json({ error: 'Sin intenciones válidas' });

  try {
    for (const i of intents) {
      const nombre = i.nombre?.trim();
      const ejemplos = Array.isArray(i.ejemplos) ? i.ejemplos : [];
      const respuesta = i.respuesta?.trim();
      if (!nombre || !ejemplos.length || !respuesta) continue;

      await pool.query(
        `INSERT INTO intenciones (tenant_id, canal, nombre, ejemplos, respuesta, activo)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         ON CONFLICT (tenant_id, canal, nombre)
         DO UPDATE SET ejemplos = EXCLUDED.ejemplos,
                       respuesta = EXCLUDED.respuesta,
                       updated_at = NOW()`,
        [tenantId, canal, nombre, ejemplos, respuesta]
      );
    }

    res.json({ ok: true, message: 'Intenciones guardadas ✅' });
  } catch (err) {
    console.error('❌ POST /api/intents error:', err);
    res.status(500).json({ error: 'Error interno al guardar' });
  }
});

router.delete('/:id', authenticateUser, async (req, res) => {
  const tenantId = (req as any).user?.tenant_id;
  const id = Number(req.params.id);
  if (!tenantId || !id) return res.status(400).json({ error: 'ID o tenant inválido' });

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM intenciones WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Intención no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/intents/:id error:', err);
    res.status(500).json({ error: 'Error eliminando intención' });
  }
});

export default router;
