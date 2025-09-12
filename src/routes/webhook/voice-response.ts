// src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

// locale para Twilio
const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

// Regex de URL robusto (http, https, www, dominios simples)
const URL_REGEX =
  /(https?:\/\/[^\s)<>"']+|www\.[^\s)<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)<>"']*)?)/gi;

// quita caracteres inválidos para XML, emojis, etiquetas, y recorta
const sanitizeForSay = (s: string) => {
  const withoutBadXml = (s || '').replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD]/g, ' ');
  const noTags = withoutBadXml.replace(/[<>&]/g, ' ');
  const noEmoji = noTags.replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, ' ');
  const compact = noEmoji.replace(/\s+/g, ' ').trim().slice(0, 1500);
  return compact || '...';
};

const wantsSms = (t: string) =>
  /\b(sms|texto|mensaje de texto|mand(a|e|alo).*(sms|texto)|send.*(text|sms))\b/i.test(t);

const normIntent = (t: string) => {
  const s = (t || '').toLowerCase();
  if (/(reservar|reserva|agendar|agenda|cita|book|booking)/.test(s)) return 'reservar';
  if (/(comprar|pagar|buy|purchase|checkout)/.test(s)) return 'comprar';
  if (/(soporte|ayuda|support|help)/.test(s)) return 'soporte';
  if (/(web|sitio|site|website|pagina)/.test(s)) return 'web';
  return 'otro';
};

const GATHER_ACTION_PATH = '/webhook/voice-response';

router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();
  const numero = to.replace(/^tel:/, '');
  const fromNumber = from.replace(/^tel:/, '');
  const userInput = (req.body.SpeechResult || '').toString().trim();

  try {
    const tRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_voice_number = $1 LIMIT 1',
      [numero]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
      const vr = new twiml.VoiceResponse();
      vr.say({ voice: 'alice', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!');
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
    const voiceName: any = locale.startsWith('es') ? 'Polly.Conchita'
                      : locale.startsWith('en') ? 'Polly.Joanna'
                      : 'alice';

    const vr = new twiml.VoiceResponse();

    // primera vuelta: sin SpeechResult → saludo + gather
    if (!userInput) {
      const initial = sanitizeForSay(
        `Hola, soy Amy de ${tenant.name || 'nuestro negocio'}. ¿En qué puedo ayudarte?`
      );
      vr.say({ language: locale as any, voice: voiceName }, initial);
      vr.gather({
        input: ['speech'] as any,
        action: GATHER_ACTION_PATH,
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        timeout: 6,
        actionOnEmptyResult: true
      });
      return res.type('text/xml').send(vr.toString());
    }

    // --- OpenAI para respuesta breve ---
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
              `Eres Amy, una asistente telefónica amable y concisa del negocio ${tenant.name || ''}.
               Nunca pronuncies URLs ni códigos largos. Si necesitas compartir un enlace, di:
               "Te lo envío por SMS", y NO leas el link. Responde siempre en frases cortas y naturales.`
          },
          { role: 'user', content: userInput }
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
      console.warn('⚠️ OpenAI falló, usando fallback:', e);
    }

    // --- Post-proceso: NO leer enlaces; si hay URL o el usuario pide SMS → enviamos SMS ---
    const modelUrls = Array.from(new Set((respuesta.match(URL_REGEX) || []).map(u => u.trim())));
    const askedSms = wantsSms(userInput);
    let smsSent = false;

    // si el usuario pidió SMS pero no capturamos URL, intenta buscar por intención en links_utiles
    let smsLinks: { url: string; nombre?: string }[] = modelUrls.map(url => ({ url }));

    if ((askedSms || modelUrls.length > 0) && smsLinks.length === 0) {
      const intent = normIntent(userInput);
      if (['reservar', 'comprar', 'soporte', 'web'].includes(intent)) {
        const { rows } = await pool.query(
          `SELECT url, nombre
           FROM links_utiles
           WHERE tenant_id = $1 AND tipo = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [tenant.id, intent]
        );
        if (rows[0]?.url) smsLinks.push({ url: rows[0].url, nombre: rows[0].nombre });
      }
    }

    if (smsLinks.length > 0) {
      try {
        const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || numero;
        const client = Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

        const body =
          (locale.startsWith('es')
            ? `Aquí tienes el enlace: ${smsLinks.map(l => l.nombre ? `${l.nombre}: ${l.url}` : l.url).join(' | ')}`
            : `Here is the link: ${smsLinks.map(l => l.nombre ? `${l.nombre}: ${l.url}` : l.url).join(' | ')}`);

        await client.messages.create({ from: smsFrom, to: fromNumber, body });
        smsSent = true;
      } catch (e) {
        console.warn('⚠️ Envío SMS falló:', e);
      }

      // elimina URLs del habla y avisa
      if (smsSent) {
        respuesta = respuesta.replace(URL_REGEX, '').replace(/\s{2,}/g, ' ').trim();
        respuesta += locale.startsWith('es')
          ? ' Te acabo de enviar el enlace por SMS.'
          : ' I just texted you the link.';
      }
    }

    // sanitiza antes de hablar
    const speakOut = sanitizeForSay(respuesta);

    // persistencia
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

    // ¿cerramos?
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    vr.say({ language: locale as any, voice: voiceName }, speakOut);

    if (!fin) {
      vr.gather({
        input: ['speech'] as any,
        action: GATHER_ACTION_PATH,
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        timeout: 6,
        actionOnEmptyResult: true
      });
    } else {
      vr.say(
        { language: locale as any, voice: voiceName },
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
