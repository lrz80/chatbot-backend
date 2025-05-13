import { Router, Request, Response } from 'express';
import pool from '../../lib/db';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const {
    MessageSid,
    MessageStatus,
    To,
    From,
    SmsSid,
    ErrorCode,
    ErrorMessage,
    SmsStatus,
  } = req.body;

  const campaign_id = req.query.campaign_id ? parseInt(req.query.campaign_id as string, 10) : null;

  const status = MessageStatus || SmsStatus;
  const toNumber = To?.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = From?.replace('whatsapp:', '').replace('tel:', '');
  const messageSid = MessageSid || SmsSid;

  console.log("📩 Webhook SMS recibido:", {
    messageSid,
    status,
    toNumber,
    fromNumber,
    error: ErrorMessage || null,
    campaign_id,
  });

  try {
    const tenantRes = await pool.query(
      'SELECT id FROM tenants WHERE twilio_sms_number = $1 LIMIT 1',
      [toNumber]
    );
    const tenantId = tenantRes.rows[0]?.id;

    await pool.query(
      `INSERT INTO sms_status_logs (
        tenant_id, message_sid, status, to_number, from_number,
        error_code, error_message, campaign_id, timestamp
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, NOW()
      )
      ON CONFLICT (message_sid)
      DO UPDATE SET
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        campaign_id = EXCLUDED.campaign_id,
        timestamp = NOW()`,
      [
        tenantId || null,
        messageSid,
        status,
        toNumber,
        fromNumber,
        ErrorCode || null,
        ErrorMessage || null,
        campaign_id,
      ]
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error registrando status SMS:', err);
    res.sendStatus(500);
  }
});

export default router;
