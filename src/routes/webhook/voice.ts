import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

// Primer paso: saludo inicial y recopilación por voz
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

    const response = new twiml.VoiceResponse();

    // 💬 Saludo inicial
    response.say(
      { voice: 'alice', language: tenant.voice_language || 'es-ES' },
      tenant.bienvenida || 'Hola, gracias por llamar. Por favor, dime en qué puedo ayudarte después del tono.'
    );

    // 💾 Registrar llamada entrante (sin texto aún)
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voice', $3)`,
      [tenant.id, '[Inicio de llamada]', fromNumber]
    );

    // 💾 Guardar interacción en tabla de estadísticas
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
      VALUES ($1, $2, NOW())`,
      [tenant.id, 'voice']
    );

    // 🎙️ Recolección de voz
    response.gather({
      input: ['speech'],
      action: '/webhook/voice-response',
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
