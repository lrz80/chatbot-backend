import { Router, Request, Response } from 'express';
import pool from '../../lib/db';

const router = Router();

/**
 * Configura este endpoint en Twilio:
 * En el número de voz → "Status Callback URL" → POST https://api.aamy.ai/webhook/voice-status
 * Event: Completed
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const callSid = (req.body.CallSid || '').toString();
    const callStatus = (req.body.CallStatus || '').toString(); // 'completed', etc.
    const toNumber = ((req.body.To || '') as string).replace(/^tel:/, '');
    const durationSec = parseInt((req.body.CallDuration || '0').toString(), 10) || 0;

    if (!callSid) return res.sendStatus(204);

    // Buscar tenant por número de voz
    const { rows } = await pool.query(
      `SELECT id FROM tenants WHERE twilio_voice_number = $1 LIMIT 1`,
      [toNumber]
    );
    const tenant = rows[0];
    if (!tenant) return res.sendStatus(204);

    if (callStatus === 'completed') {
      // Redondeo a minuto entero (mínimo 1)
      const minutes = Math.max(1, Math.ceil(durationSec / 60));

      // Guardar idempotente por CallSid
      await pool.query(
        `INSERT INTO voice_minutes_usage (tenant_id, call_sid, duration_sec, minutes_billed)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (call_sid)
         DO UPDATE SET duration_sec = EXCLUDED.duration_sec,
                       minutes_billed = EXCLUDED.minutes_billed`,
        [tenant.id, callSid, durationSec, minutes]
      );
    }

    res.sendStatus(204);
  } catch (e) {
    console.error('[webhook/voice-status] error:', e);
    res.sendStatus(500);
  }
});

export default router;
