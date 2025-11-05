// src/routes/ctas.ts
import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

// Usa el shape REAL que pone tu middleware: { uid, tenant_id, email? }
type AuthedReq = Request & {
  user?: { uid: string; tenant_id: string; email?: string };
};

const router = Router();
router.use(authenticateUser);

// GET: listar CTAs del tenant
router.get('/', async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const { rows } = await pool.query(
      'SELECT id, intent, cta_text, cta_url, updated_at FROM tenant_ctas WHERE tenant_id = $1 ORDER BY updated_at DESC',
      [tenantId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[CTAS][GET] Error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST: crear o actualizar CTA (upsert por intent)
router.post('/', async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const { intent, cta_text, cta_url } = req.body || {};
    if (
      typeof intent !== 'string' || !intent.trim() ||
      typeof cta_text !== 'string' || !cta_text.trim() ||
      typeof cta_url !== 'string' || !cta_url.trim()
    ) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: intent, cta_text, cta_url' });
    }

    const { rows } = await pool.query(
      `INSERT INTO tenant_ctas (tenant_id, intent, cta_text, cta_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, intent)
       DO UPDATE SET
         cta_text  = EXCLUDED.cta_text,
         cta_url   = EXCLUDED.cta_url,
         updated_at = NOW()
       RETURNING id, tenant_id, intent, cta_text, cta_url, updated_at`,
      [tenantId, intent.trim().toLowerCase(), cta_text.trim(), cta_url.trim()]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[CTAS][POST] Error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE: eliminar CTA por id
router.delete('/:id', async (req: AuthedReq, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing id param' });

    await pool.query('DELETE FROM tenant_ctas WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[CTAS][DELETE] Error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
