import { Router, Request, Response } from 'express';
import pool from '../../lib/db';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const from = req.body.From || '';
  const numero = from.replace('tel:', '');

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_sms_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    console.log(`📩 SMS de ${numero} para tenant ${tenant.name}`);

    res.send('<Response><Message>Recibido por SMS ✅</Message></Response>');
  } catch (err) {
    console.error('❌ Error SMS Webhook:', err);
    res.sendStatus(500);
  }
});

export default router;
