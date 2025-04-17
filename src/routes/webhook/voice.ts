import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import OpenAI from 'openai';

const router = Router();

// Configuración de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

// Primer paso: saludo inicial y recopilación por voz
router.post('/', async (req, res) => {
  const to = req.body.To || '';
  const numero = to.replace('tel:', '');

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const response = new twiml.VoiceResponse();

    response.say(
      { voice: 'alice', language: tenant.voice_language || 'es-ES' },
      tenant.bienvenida || 'Hola, gracias por llamar. Por favor, dime en qué puedo ayudarte después del tono.'
    );

    response.gather({
      input: ['speech'],
      action: '/webhook/voice-response',
      method: 'POST',
      language: tenant.voice_language || 'es-ES',
      speechTimeout: 'auto'
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;

