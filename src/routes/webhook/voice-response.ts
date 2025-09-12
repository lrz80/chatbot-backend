// src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
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

// Heurística: ¿pidió que lo mandemos por SMS?
const askedForSms = (t: string) =>
  /\b(sms|mensaje|texto|textea|mand(a|e|alo)|env(i|í)a(lo)?|p[aá]same|p[aá]salo)\b/i.test(t) &&
  /\b(link|enlace|liga|url|p[aá]gina|web|reserva|pagar|comprar|soporte)\b/i.test(t);

// Mapea palabras a un tipo por defecto
const guessType = (t: string): 'reservar'|'comprar'|'soporte'|'web' => {
  const s = t.toLowerCase();
  if (/(reserv|agend|cita|turno)/.test(s)) return 'reservar';
  if (/(compr|pag|checkout|pago)/.test(s)) return 'comprar';
  if (/(soporte|ayuda|reclamo|ticket)/.test(s)) return 'soporte';
  if (/(web|sitio|p[aá]gina|home)/.test(s)) return 'web';
  // prioridad por negocio: reservar > comprar > web > soporte
  return 'reservar';
};

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
    const voiceName: any = 'alice';

    const vr = new twiml.VoiceResponse();

    // Primer turno: sin SpeechResult -> saludo + gather
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

    // --- OpenAI para respuesta corta ---
    let respuesta =
      locale.startsWith('es')
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
              `Eres Amy, asistente telefónica amable y concisa del negocio ${tenant.name || ''}.`
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

    // 1) ¿Hay etiqueta [[SMS:tipo]] en la respuesta?
    const tagMatch = respuesta.match(/\[\[SMS:(reservar|comprar|soporte|web)\]\]/i);
    let smsType: 'reservar'|'comprar'|'soporte'|'web' | null = tagMatch
      ? (tagMatch[1].toLowerCase() as any)
      : null;

    // 2) Si no hay etiqueta, ¿el usuario pidió SMS explícitamente?
    if (!smsType && askedForSms(userInput)) {
      smsType = guessType(userInput);
    }

    // Limpia etiqueta del texto antes de decirlo
    if (tagMatch) {
      respuesta = respuesta.replace(tagMatch[0], '').trim();
    }

    const speakOut = sanitizeForSay(respuesta);

    // Persistir conversación
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

    // Envío de SMS si corresponde
    if (smsType) {
      try {
        const linkRes = await pool.query(
          `SELECT url, nombre
             FROM links_utiles
            WHERE tenant_id = $1 AND tipo = $2
            ORDER BY created_at DESC
            LIMIT 1`,
          [tenant.id, smsType]
        );

        const url = linkRes.rows[0]?.url;
        const nombre = linkRes.rows[0]?.nombre || smsType;

        if (url) {
          // usa número SMS si existe; si no, el mismo número de voz (si es SMS-capable)
          const smsFrom =
            tenant.twilio_sms_number ||
            tenant.twilio_voice_number ||
            numero;

          const client = Twilio(
            process.env.TWILIO_ACCOUNT_SID!,
            process.env.TWILIO_AUTH_TOKEN!
          );

          await client.messages.create({
            from: smsFrom,
            to: fromNumber,
            body: `📎 ${nombre}: ${url}`,
          });

          console.log(`✅ SMS enviado (${smsType}) a ${fromNumber} desde ${smsFrom}`);
        } else {
          console.warn(`⚠️ No hay link guardado para tipo=${smsType}`);
        }
      } catch (e) {
        console.warn('⚠️ Error enviando SMS con link útil:', e);
      }
    }

    // ¿Terminamos?
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

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
