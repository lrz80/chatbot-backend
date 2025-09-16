import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';
import { cycleStartForNow } from '../../utils/billingCycle';

const router = Router();

/** Ajusta este valor si tu plan incluye otro bucket mensual */
const INCLUDED_MINUTES_PER_MONTH = 800;

router.get('/voice/minutes', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: 'Tenant no autenticado' });

    const t = await pool.query(
      `SELECT membresia_inicio FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const membresia_inicio = t.rows[0]?.membresia_inicio || new Date();
    const cicloInicio = cycleStartForNow(membresia_inicio);

    const usedQ = await pool.query(
      `SELECT COALESCE(SUM(minutes_billed),0)::int AS used
       FROM voice_minutes_usage
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cicloInicio]
    );
    const topupsQ = await pool.query(
      `SELECT COALESCE(SUM(minutes),0)::int AS bought
       FROM voice_minutes_topups
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cicloInicio]
    );

    const used = usedQ.rows[0]?.used || 0;
    const bought = topupsQ.rows[0]?.bought || 0;
    const included = INCLUDED_MINUTES_PER_MONTH;
    const total = included + bought;
    const available = Math.max(0, total - used);

    res.json({
      cycle_start: cicloInicio,
      included,
      bought,
      used,
      total,
      available
    });
  } catch (e) {
    console.error('[stats/voice/minutes] error:', e);
    res.sendStatus(500);
  }
});

export default router;
