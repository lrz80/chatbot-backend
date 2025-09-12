// src/routes/webhook/voice.ts

import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import axios from 'axios';
import { guardarAudioEnCDN } from '../../utils/uploadAudioToCDN';

const router = Router();

// Helper: obtiene la última voice_config del tenant (canal 'voz')
async function getVoiceConfig(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM voice_configs
     WHERE tenant_id = $1 AND canal = 'voz'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

// Normaliza 'es'/'en' → códigos que Twilio acepta
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').replace(/^tel:/, '');

  try {
    const tRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [to]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    const cfg = await getVoiceConfig(tenant.id);
    if (!cfg) return res.sendStatus(404);

    // Variables locales (no uses `config` fuera de scope)
    const idioma  = (cfg.idioma as string) || 'es-ES';
    const welcome = (cfg.welcome_message as string) || 'Hola, ¿en qué puedo ayudarte?';

    // Hints opcionales para ASR (si viene como array, únelos por coma)
    const hints =
      Array.isArray(cfg.voice_hints) && cfg.voice_hints.length
        ? cfg.voice_hints.join(',')
        : (typeof cfg.voice_hints === 'string' && cfg.voice_hints.trim() ? cfg.voice_hints : undefined);

    // --- TTS opcional con ElevenLabs ---
    // Si cfg.voice_name parece un Voice ID de ElevenLabs, intentamos TTS; de lo contrario usamos <Say>.
    const isLikely11Id =
      typeof cfg.voice_name === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(cfg.voice_name);

    let audioUrl: string | null = null;

    if (process.env.ELEVENLABS_API_KEY && isLikely11Id) {
      try {
        const { data } = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice_name}`,
          {
            text: welcome,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.4, similarity_boost: 0.8 }
          },
          {
            headers: {
              'xi-api-key': process.env.ELEVENLABS_API_KEY!,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg'
            },
            responseType: 'arraybuffer'
          }
        );

        const audioBuffer = Buffer.from(data);
        // Asegúrate que guardarAudioEnCDN sirva con Content-Type: audio/mpeg y HTTPS público
        audioUrl = await guardarAudioEnCDN(audioBuffer, tenant.id);

        // Guarda demo por idioma y canal = 'voz'
        await pool.query(
          `UPDATE voice_configs
             SET audio_demo_url = $1, updated_at = NOW()
           WHERE tenant_id = $2 AND canal = 'voz' AND idioma = $3`,
          [audioUrl, tenant.id, idioma]
        );
      } catch (e: any) {
        console.warn('⚠️ ElevenLabs TTS falló, uso fallback <Say>:', e?.response?.data || e?.message);
        audioUrl = null;
      }
    }

    // --- TwiML ---
    const vr = new twiml.VoiceResponse();

    // Recolecta speech o DTMF; pasa el idioma correcto
    const gather = vr.gather({
      input: ['speech', 'dtmf'] as any,     // TS: castea para evitar el error de tipos
      numDigits: 1,
      action: '/webhook/voice/gather',      // ajusta si usas un prefijo (/api, etc.)
      method: 'POST',
      language: toTwilioLocale(idioma) as any, // TS: castea para SayLanguage/GatherLanguage
      speechTimeout: 'auto',
      ...(hints ? { hints } : {})
    });

    if (audioUrl) {
      gather.play(audioUrl);
    } else {
      // Fallback TTS nativo de Twilio
      gather.say(
        { language: toTwilioLocale(idioma) as any, voice: 'alice' },
        welcome
      );
    }

    // Si el usuario no responde, despedimos cortésmente
    vr.say(
      { language: toTwilioLocale(idioma) as any, voice: 'alice' },
      idioma.startsWith('es')
        ? 'No escuché nada. ¡Hasta luego!'
        : "I didn't hear anything. Goodbye!"
    );

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

// Handler del <Gather>
router.post('/gather', async (req: Request, res: Response) => {
  const idioma = (req.body.RecognitionLanguage || req.body.language || 'es-ES') as string;
  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').trim();

  const vr = new twiml.VoiceResponse();

  const msg = digits
    ? (idioma.startsWith('es') ? `Marcaste ${digits}. Gracias por llamar.` : `You pressed ${digits}. Thanks for calling.`)
    : (idioma.startsWith('es') ? `Entendí: ${speech || 'nada'}. Gracias por llamar.` : `I heard: ${speech || 'nothing'}. Thanks for calling.`);

  vr.say({ language: toTwilioLocale(idioma) as any, voice: 'alice' }, msg);

  res.type('text/xml').send(vr.toString());
});

export default router;
