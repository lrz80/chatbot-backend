// src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

const sanitizeForSay = (s: string) =>
  (s || '')
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();
  const numero = to.replace(/^tel:/, '');
  const fromNumber = from.replace(/^tel:/, '');
  const userInputRaw = (req.body.SpeechResult || '').toString();
  const userInput = userInputRaw.trim();

  try {
    const tRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [numero]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
      const vr = new twiml.VoiceResponse();
      vr.say(
        { voice: 'alice', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!'
      );
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const cfgRes = await pool.query(
      `SELECT * FROM voice_configs
       WHERE tenant_id = $1 AND canal = 'voz'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [tenant.id]
    );
    const cfg = cfgRes.rows[0];
    if (!cfg) return res.sendStatus(404);

    const locale = toTwilioLocale(cfg.idioma || 'es-ES');
    const voiceName: any = 'alice';

    const vr = new twiml.VoiceResponse();

    // Primera vuelta: Twilio nos llamó sin SpeechResult (silencio o arranque)
    if (!userInput) {
      const initial = sanitizeForSay(
        `Hola, soy Amy de ${tenant.name || 'nuestro negocio'}. ¿En qué puedo ayudarte?`
      );
      vr.say({ language: locale as any, voice: voiceName }, initial);
      vr.gather({
        input: ['speech'] as any,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
      });
      return res.type('text/xml').send(vr.toString());
    }

    // --- OpenAI para generar respuesta corta y natural ---
    let respuesta = locale.startsWith('es')
      ? 'Disculpa, no entendí eso.'
      : "Sorry, I didn’t catch that.";

    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              `Eres Amy, una asistente telefónica amable y concisa del negocio ${tenant.name || ''}. Responde breve y natural.`
          },
          { role: 'user', content: userInput }
        ],
      });

      respuesta =
        completion.choices[0]?.message?.content?.trim() ||
        respuesta;

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
      console.warn('⚠️ OpenAI falló, usando fallback:', e);
    }

    // Sanitiza la salida antes de hablar
    const speakOut = sanitizeForSay(respuesta);

    // Persistimos conversación
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

    // (Opcional) Detecta intención y envía SMS con link útil
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const intentPrompt = `El cliente dijo: "${userInput}". Responde solo una palabra: reservar, comprar, soporte, web, otro.`;
      const intentRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: intentPrompt }]
      });
      const intent =
        intentRes.choices[0].message?.content?.toLowerCase().trim() || '';

      if (['reservar', 'comprar', 'soporte', 'web'].includes(intent)) {
        const linkRes = await pool.query(
          `SELECT url, nombre FROM links_utiles
           WHERE tenant_id = $1 AND tipo = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [tenant.id, intent]
        );
        const url = linkRes.rows[0]?.url;
        const nombre = linkRes.rows[0]?.nombre;
        if (url) {
          const smsFrom = tenant.twilio_sms_number || numero;
          const client = Twilio(
            process.env.TWILIO_ACCOUNT_SID!,
            process.env.TWILIO_AUTH_TOKEN!
          );
          await client.messages.create({
            from: smsFrom,
            to: fromNumber,
            body: `📎 ${nombre || 'Enlace'}: ${url}`
          });
        }
      }
    } catch (e) {
      console.warn('⚠️ Intent/SMS opcional falló:', e);
    }

    // ¿Cerramos conversación?
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    // Hablar
    vr.say({ language: locale as any, voice: voiceName }, speakOut);

    if (!fin) {
      vr.gather({
        input: ['speech'] as any,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
      });
    } else {
      vr.say(
        { language: locale as any, voice: voiceName },
        locale.startsWith('es')
          ? 'Gracias por tu llamada. ¡Hasta luego!'
          : 'Thanks for calling. Goodbye!'
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
