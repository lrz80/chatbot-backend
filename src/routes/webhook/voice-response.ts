import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

// helpers
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
function sanitizeSayText(s: string, max = 3000) {
  return (s || '')
    .replace(/[<>&]/g, ' ')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();
  const numero = to.replace(/^tel:/, '');
  const fromNumber = from.replace(/^tel:/, '');
  const userInput = (req.body.SpeechResult || '').toString().trim();

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [numero]
    );
    const tenant = tenantRes.rows[0];
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

    // Primera vuelta: si no hubo voz
    const vr = new twiml.VoiceResponse();
    if (!userInput) {
      vr.say({ voice: twilioVoice as any },
        locale.startsWith('es') ? '¿En qué puedo ayudarte?' : 'How can I help you?'
      );

      const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || '';
      const actionUrl = `${base}/webhook/voice-response`;

      vr.gather({
        input: ['speech'] as ('speech' | 'dtmf')[],
        action: actionUrl,
        method: 'POST',
        language: locale as any,   // solo ASR
        speechTimeout: 'auto',
        ...(cfg.voice_hints ? { hints: String(cfg.voice_hints) } : {}),
      });
      return res.type('text/xml').send(vr.toString());
    }

    // OpenAI para respuesta corta
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    let respuesta = locale.startsWith('es')
      ? 'Lo siento, no entendí eso.'
      : "Sorry, I didn't catch that.";

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              (locale.startsWith('es')
                ? 'Eres una asistente telefónica amable y clara. Responde corto, cálido y directo.'
                : 'You are a friendly and clear phone assistant. Reply briefly, warmly, and directly.'),
          },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

      const tokens = completion.usage?.total_tokens || 0;
      if (tokens > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'voz', date_trunc('month', CURRENT_DATE), $2)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, tokens]
        );
      }
    } catch (e) {
      console.warn('⚠️ OpenAI falló; usando fallback genérico:', e);
    }

    // Guardar conversación
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
      [tenant.id, userInput, fromNumber || 'anónimo']
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
      [tenant.id, respuesta, numero || 'sistema']
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voz', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(numero);

    // Decidir si seguimos
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    // ⛑️ Sanear y decir
    const safe = sanitizeSayText(respuesta);
    vr.say({ voice: twilioVoice as any }, safe);

    if (!fin) {
      const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || '';
      const actionUrl = `${base}/webhook/voice-response`;

      vr.gather({
        input: ['speech'] as ('speech' | 'dtmf')[],
        action: actionUrl,
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        ...(cfg.voice_hints ? { hints: String(cfg.voice_hints) } : {}),
      });
    } else {
      vr.say({ voice: twilioVoice as any },
        locale.startsWith('es') ? 'Gracias por tu llamada. ¡Hasta luego!' : 'Thanks for calling. Goodbye!'
      );
      vr.hangup();
    }

    res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    res.sendStatus(500);
  }
});

export default router;
