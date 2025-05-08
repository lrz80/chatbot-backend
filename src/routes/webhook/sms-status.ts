// src/routes/webhook/sms-status.ts

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
    campaign_id // ✅ opcionalmente recibido desde Twilio o sistema de envío
  } = req.body;

  const status = MessageStatus || SmsStatus;
  const toNumber = To?.replace('whatsapp:', '').replace('tel:', '');
  const fromNumber = From?.replace('whatsapp:', '').replace('tel:', '');

  try {
    // Buscar tenant relacionado
    const tenantRes = await pool.query(
      'SELECT id FROM tenants WHERE twilio_sms_number = $1 LIMIT 1',
      [toNumber]
    );
    const tenantId = tenantRes.rows[0]?.id;

    // Registrar el log
    await pool.query(
      `INSERT INTO sms_status_logs (
        tenant_id, message_sid, status, to_number, from_number,
        error_code, error_message, campaign_id, timestamp
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, NOW()
      )`,
      [
        tenantId || null,
        MessageSid || SmsSid,
        status,
        toNumber,
        fromNumber,
        ErrorCode || null,
        ErrorMessage || null,
        campaign_id || null // puede venir desde la función de envío
      ]
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error registrando status SMS:', err);
    res.sendStatus(500);
  }
});

export default router;
