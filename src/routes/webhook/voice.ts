import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';

const router = Router();

// Normaliza a locales que Twilio acepta
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es-mx')) return 'es-MX' as const;
  if (c.startsWith('es'))    return 'es-ES' as const;
  if (c.startsWith('en-gb')) return 'en-GB' as const;
  if (c.startsWith('en'))    return 'en-US' as const;
  return 'es-ES' as const;
};

// Voz por defecto por locale (Polly vía Twilio)
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

// Última voice_config del tenant (canal 'voz')
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
      vr.say({ voice: 'Polly.Conchita', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!');
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const cfg = await getVoiceConfig(tenant.id);
    if (!cfg) return res.sendStatus(404);

    const idioma = (cfg.idioma || 'es-ES') as string;
    const locale = toTwilioLocale(idioma);
    const twilioVoice = pickTwilioVoice(cfg.voice_name, idioma);
    const welcome = (cfg.welcome_message || 'Hola, ¿en qué puedo ayudarte?').trim();

    // --- TwiML ---
    const vr = new twiml.VoiceResponse();

    const gather = vr.gather({
      input: ['speech'] as ('speech' | 'dtmf')[],
      action: '/webhook/voice-response', // ajusta si usas prefijo /api
      method: 'POST',
      language: locale as any,
      speechTimeout: 'auto',
      ...(cfg.voice_hints ? { hints: String(cfg.voice_hints) } : {}),
    });

    // ⚠️ FIX: castear voz a any para contentar al type checker
    gather.say({ language: locale as any, voice: twilioVoice as any }, welcome);

    // Si no hay respuesta, despedimos
    vr.say(
      { language: locale as any, voice: twilioVoice as any },
      locale.startsWith('es')
        ? 'No escuché nada. ¡Hasta luego!'
        : "I didn't hear anything. Goodbye!"
    );

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en webhook de voz:', err);
    res.sendStatus(500);
  }
});

export default router;
