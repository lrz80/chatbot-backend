import { Router, Request, Response } from 'express';
import pool from '../../lib/db';

const router = Router();

function stripProto(v?: string | null) {
  return (v || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^tel:/i, '')
    .trim();
}

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

  // Si configuraste el StatusCallback como .../sms-status?campaign_id=123
  const campaign_id = req.query.campaign_id
    ? Number.parseInt(String(req.query.campaign_id), 10)
    : null;

  const status = (MessageStatus || SmsStatus || '').toLowerCase();
  const toNumber = stripProto(To);
  const fromNumber = stripProto(From);
  const messageSid = (MessageSid || SmsSid || '').trim();

  console.log('📩 Webhook SMS recibido:', {
    messageSid,
    status,
    toNumber,
    fromNumber,
    error: ErrorMessage || null,
    campaign_id,
  });

  if (!messageSid || !status) {
    // Evento inválido: responde 200 para que Twilio no reintente eternamente
    return res.sendStatus(200);
  }

  try {
    // Para SMS outbound:
    //   From = TU número Twilio (identifica tenant)
    //   To   = número del cliente
    let tenantId: string | null = null;

    // 1) Buscar por número Twilio de SMS
    const t1 = await pool.query(
      'SELECT id FROM tenants WHERE twilio_sms_number = $1 LIMIT 1',
      [fromNumber]
    );
    tenantId = t1.rows[0]?.id || null;

    // 2) Si no aparece, intentar por WhatsApp (por si decidiste reutilizar el endpoint)
    if (!tenantId) {
      const t2 = await pool.query(
        'SELECT id FROM tenants WHERE twilio_number = $1 LIMIT 1',
        [fromNumber]
      );
      tenantId = t2.rows[0]?.id || null;
    }

    // 3) Si aún no, y tenemos campaign_id, inferir tenant desde la campaña
    if (!tenantId && campaign_id) {
      const t3 = await pool.query(
        'SELECT tenant_id FROM campanas WHERE id = $1',
        [campaign_id]
      );
      tenantId = t3.rows[0]?.tenant_id || null;
    }

    // Si incluso así no encontramos tenant, almacenamos igual (pero mejor que sea raro)
    // ⚠️ Si tu índice único incluye tenant_id, que no sea NULL para que aplique bien.
    // Hacemos fallback a cadena vacía para que el UNIQUE funcione.
    const tenantKey = tenantId ?? '';

    await pool.query(
      `
      INSERT INTO sms_status_logs (
        tenant_id, message_sid, status, to_number, from_number,
        error_code, error_message, campaign_id, timestamp
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, NOW()
      )
      ON CONFLICT (tenant_id, campaign_id, message_sid, status)
      DO UPDATE SET
        to_number    = EXCLUDED.to_number,
        from_number  = EXCLUDED.from_number,
        error_code   = EXCLUDED.error_code,
        error_message= EXCLUDED.error_message,
        timestamp    = NOW()
      `,
      [
        tenantKey,                // $1
        messageSid,               // $2
        status,                   // $3
        toNumber,                 // $4
        fromNumber,               // $5
        ErrorCode || null,        // $6
        ErrorMessage || null,     // $7
        campaign_id,              // $8
      ]
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error registrando status SMS:', err);
    // Responde 200 para que Twilio no reintente infinitamente si es un error lógico no recuperable
    res.sendStatus(200);
  }
});

export default router;
