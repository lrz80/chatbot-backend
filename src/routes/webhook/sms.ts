// src/routes/webhook/sms.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const from = req.body.From || '';
  const to = req.body.To || '';
  const userInput = req.body.Body || '';
  const fromNumber = from.replace('tel:', '');
  const toNumber = to.replace('tel:', '');

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_sms_number = $1',
      [toNumber]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    console.log(`📩 SMS recibido de ${fromNumber} para tenant ${tenant.name}`);

    // 💾 Guardar mensaje del usuario
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'sms', $3)`,
      [tenant.id, userInput, fromNumber]
    );
    
    // 💾 Guardar interacción en tabla de estadísticas
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
      VALUES ($1, $2, NOW())`,
      [tenant.id, 'sms']
    );

    // 🔢 Incrementar uso real
    await incrementarUsoPorNumero(toNumber);

    // 📨 Respuesta básica
    res.type('text/xml');
    res.send(`<Response><Message>Recibido por SMS ✅</Message></Response>`);
  } catch (err) {
    console.error('❌ Error SMS Webhook:', err);
    res.sendStatus(500);
  }
});

export default router;
