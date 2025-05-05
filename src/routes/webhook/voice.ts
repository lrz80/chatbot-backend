// ✅ src/routes/webhook/voice.ts

import { Router } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import axios from 'axios';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';

const router = Router();

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

    const configRes = await pool.query(
      'SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 LIMIT 1',
      [tenant.id, 'voz']
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
    const textoBienvenida = config.welcome_message || 'Hola, ¿en qué puedo ayudarte?';

    const audioRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: textoBienvenida,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );
    
    const audioBuffer = Buffer.from(audioRes.data);
    const audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id);    

    const response = new twiml.VoiceResponse();
    response.play(audioUrl);

    response.gather({
      input: ['speech'],
      action: '/webhook/voice-response',
      method: 'POST',
      language: config.idioma || 'es-ES',
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
