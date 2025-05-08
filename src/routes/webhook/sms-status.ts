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
    AccountSid,
    SmsStatus
  } = req.body;

  const status = MessageStatus || SmsStatus;
  const toNumber = To?.replace('whatsapp:', '').replace('tel:', '');

  try {
    // Opcional: buscar el tenant por número si quieres asociar
    const tenantRes = await pool.query(
      'SELECT id FROM tenants WHERE twilio_sms_number = $1 LIMIT 1',
      [toNumber]
    );
    const tenantId = tenantRes.rows[0]?.id;

    // Registrar status en log
    await pool.query(
      `INSERT INTO sms_status_logs (
        tenant_id, message_sid, status, to_number, from_number, error_code, error_message, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        tenantId || null,
        MessageSid || SmsSid,
        status,
        To,
        From,
        ErrorCode || null,
        ErrorMessage || null
      ]
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error registrando status SMS:', err);
    res.sendStatus(500);
  }
});

export default router;
