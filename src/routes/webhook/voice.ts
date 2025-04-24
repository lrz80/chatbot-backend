import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

router.post('/', async (req, res) => {
  const to = req.body.To || '';
  const from = req.body.From || '';
  const numero = to.replace('tel:', '');
  const fromNumber = from.replace('tel:', '');

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const voiceConfigRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1',
      [tenant.id]
    );
    const voiceConfig = voiceConfigRes.rows[0];

    const response = new twiml.VoiceResponse();

    response.say(
      { voice: 'alice', language: tenant.voice_language || 'es-ES' },
      voiceConfig?.welcome_message || 'Hola, gracias por llamar. Por favor, dime en qué puedo ayudarte después del tono.'
    );

    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`,
      [tenant.id, '[Inicio de llamada]', fromNumber]
    );

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voice', NOW())`,
      [tenant.id]
    );

    response.gather({
      input: ['speech'],
      action: 'https://api.aamy.ai/api/webhooks/voice-response',
      method: 'POST',
      language: tenant.voice_language || 'es-ES',
      speechTimeout: 'auto',
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;
