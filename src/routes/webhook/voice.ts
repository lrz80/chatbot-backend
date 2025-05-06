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
      'SELECT * FROM voice_configs WHERE tenant_id = $1 AND canal = $2 ORDER BY created_at DESC LIMIT 1',
      [tenant.id, 'voz']
    );
    const config = configRes.rows[0];
    if (!config) return res.sendStatus(404);

    const voiceId = config.voice_name || 'EXAVITQu4vr4xnSDxMaL';
    const idioma = config.idioma || 'es-ES';

    // ✅ Saludo con SSML (pausas naturales)
    const textoBienvenida = config.welcome_message || 'Hola, ¿en qué puedo ayudarte?';
    const ssmlBienvenida = `<speak>${textoBienvenida.replace(/\.\s*/g, '. <break time="400ms"/> ')}</speak>`;

    const audioRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: ssmlBienvenida,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/ssml+xml',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );

    const audioBuffer = Buffer.from(audioRes.data);
    const audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id);

    // ✅ (opcional) Guardar demo generado
    await pool.query(
      `UPDATE voice_configs SET audio_demo_url = $1, updated_at = NOW()
       WHERE tenant_id = $2 AND canal = 'voz'`,
      [audioUrl, tenant.id]
    );

    const response = new twiml.VoiceResponse();
    response.play(audioUrl);
    response.gather({
      input: ['speech'],
      action: '/webhook/voice-response',
      method: 'POST',
      language: idioma,
      speechTimeout: 'auto',
    });

    res.type('text/xml').send(response.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;
