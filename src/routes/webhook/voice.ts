import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

router.post('/', async (req, res) => {
  const to = req.body.To || '';
  const numero = to.replace('tel:', '');

  try {
    // 🔍 Buscar el tenant por número de voz
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    // 📄 Buscar configuración de voz
    const configRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1',
      [tenant.id]
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const response = new twiml.VoiceResponse();
    response.say(
      {
        voice: config.voice_name || 'alice',
        language: config.idioma || 'es-ES',
      },
      config.welcome_message || 'Hola, gracias por llamar. ¿En qué puedo ayudarte?'
    );
    response.pause({ length: 1 });
    response.hangup();

    console.log("✅ Webhook de voz activo para:", tenant.name);

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error("❌ Error en webhook de voz:", err);
    res.sendStatus(500);
  }
});

export default router;
