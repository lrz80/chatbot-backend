import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = Router();

/**
 * POST /api/voice/topup
 * Body: { minutes: number, source?: string }
 * - minutes: cantidad de minutos comprados
 * - source: opcional, id de Stripe u observación
 */
router.post('/voice/topup', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const minutes = Math.max(1, parseInt(req.body.minutes, 10));
    const source = (req.body.source || '').toString();

    await pool.query(
      `INSERT INTO voice_minutes_topups (tenant_id, minutes, source)
       VALUES ($1, $2, NULLIF($3, ''))`,
      [tenantId, minutes, source]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[voice/topup] error:', e);
    res.sendStatus(500);
  }
});

export default router;
