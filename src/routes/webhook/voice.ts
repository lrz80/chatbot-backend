import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

// --- helpers ---
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es-mx')) return 'es-MX' as const;
  if (c.startsWith('es'))    return 'es-ES' as const;
  if (c.startsWith('en-gb')) return 'en-GB' as const;
  if (c.startsWith('en'))    return 'en-US' as const;
  return 'es-ES' as const;
};

const DEFAULT_VOICE_BY_LOCALE: Record<string, string> = {
  'es-ES': 'Polly.Lucia',
  'es-MX': 'Polly.Mia',
  'en-US': 'Polly.Joanna',
  'en-GB': 'Polly.Amy',
};

function pickTwilioVoice(voiceName?: string, idioma?: string) {
  const v = (voiceName || '').trim();
  const loc = toTwilioLocale(idioma);
  if (v) return v.startsWith('Polly.') ? v : `Polly.${v}`;
  return DEFAULT_VOICE_BY_LOCALE[loc] || 'Polly.Lucia';
}

// quita emojis, < > &, comprime espacios y limita longitud
function sanitizeSayText(s: string, max = 3000) {
  return (s || '')
    .replace(/[<>&]/g, ' ')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // emojis/surrogates
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString().replace(/^tel:/, '');

  try {
    const tRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [to]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
      const vr = new twiml.VoiceResponse();
      vr.say({ voice: 'Polly.Conchita' as any }, 'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!');
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const { rows } = await pool.query(
      `SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND canal = 'voz'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [tenant.id]
    );
    const cfg = rows[0];
    if (!cfg) return res.sendStatus(404);

    const idioma = (cfg.idioma || 'es-ES') as string;
    const locale = toTwilioLocale(idioma);
    const twilioVoice = pickTwilioVoice(cfg.voice_name, idioma);
    const rawWelcome = (cfg.welcome_message || 'Hola, ¿en qué puedo ayudarte?').trim();
    const welcome = sanitizeSayText(rawWelcome);

    // URL absoluta para el action
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || '';
    const actionUrl = `${base}/webhook/voice-response`;

    const vr = new twiml.VoiceResponse();

    const gather = vr.gather({
      input: ['speech'] as ('speech' | 'dtmf')[],
      action: actionUrl,
      method: 'POST',
      language: locale as any,           // ← solo para ASR
      speechTimeout: 'auto',
      ...(cfg.voice_hints ? { hints: String(cfg.voice_hints) } : {}),
    });

    // ⚠️ NO pasamos language cuando usamos Polly.*
    gather.say({ voice: twilioVoice as any }, welcome);

    // Mensaje de “no te oí”
    vr.say(
      { voice: twilioVoice as any },
      locale.startsWith('es') ? 'No escuché nada. ¡Hasta luego!' : "I didn't hear anything. Goodbye!"
    );

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;
