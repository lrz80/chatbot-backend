// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import Twilio from 'twilio';

const router = Router();

function formatTimesForLocale(text: string, locale: 'es-ES' | 'en-US') {
  // match HH:MM (24h o 12h)
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hhStr, mm) => {
    const hh = parseInt(hhStr, 10);
    if (locale === 'en-US') {
      const ampm = hh >= 12 ? 'pm' : 'am';
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return `${h12}:${mm} ${ampm}`;
    } else {
      // español: 24h claras (evita “meridiano”)
      return `${hh.toString().padStart(2, '0')}:${mm}`;
    }
  });
}

const toTwilioLocale = (code?: string) => {
  const c = (code || '').toLowerCase();
  if (c.startsWith('es')) return 'es-ES' as const;
  if (c.startsWith('en')) return 'en-US' as const;
  if (c.startsWith('pt')) return 'pt-BR' as const;
  return 'es-ES' as const;
};

const sanitizeForSay = (s: string) =>
  (s || '')
    // quita markdown básico y asteriscos
    .replace(/[*_`~^>#-]+/g, ' ')
    // evita leer URLs largas (las quitamos, igual ya las mandamos por SMS)
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    // evita leer HTML
    .replace(/[<>&]/g, ' ')
    // normaliza espacios y recorta
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

// ———————————————————————————
//  Detección de SMS (usuario / asistente) + tipo de link
// ———————————————————————————
const askedForSms = (t: string) => {
  const s = (t || '').toLowerCase();
  return (
    /(\bsms\b|\bmensaje\b|\btexto\b|\bmand(a|e|alo)\b|\benv[ií]a(lo)?\b|\bp[aá]same\b|\bp[aá]salo\b|\btext\b|\btext me\b|\bmessage me\b)/i.test(
      s
    ) &&
    /link|enlace|liga|url|p[aá]gina|web|reserv|agend|cita|turno|compr|pag|pago|checkout|soporte|support/i.test(s)
  );
};

const didAssistantPromiseSms = (t: string) =>
  /\b(te lo (?:env[ií]o|enviar[eé]) por sms|te lo mando por sms|te lo envío por mensaje|te lo mando por mensaje|i'?ll text it to you|i'?ll send it by text)\b/i.test(
    t || ''
  );

type LinkType = 'reservar' | 'comprar' | 'soporte' | 'web';

// heurística: decide tipo por palabras clave (usa mezcla de input usuario y respuesta asistente)
const guessType = (t: string): LinkType => {
  const s = (t || '').toLowerCase();
  if (/(reserv|agend|cita|turno|booking|appointment)/.test(s)) return 'reservar';
  if (/(compr|pag|pago|checkout|buy|pay|payment)/.test(s)) return 'comprar';
  if (/(soporte|support|ticket|help|ayuda|reclamo)/.test(s)) return 'soporte';
  if (/(web|sitio|p[aá]gina|home|website)/.test(s)) return 'web';
  // fallback razonable
  return 'reservar';
};

// Normaliza un texto corto para logs
const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

// ———————————————————————————
//  Handler
// ———————————————————————————
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

    // Voice config más reciente
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

    // Primera vuelta: sin SpeechResult → saludo + gather
    if (!userInput) {
      const initial = sanitizeForSay(
        `Hola, soy Amy de ${tenant.name || 'nuestro negocio'}. ¿En qué puedo ayudarte?`
      );
      vr.say({ language: locale as any, voice: voiceName }, initial);
      vr.gather({
        input: ['speech'] as any,
        action: '/webhook/voice-response', // ajusta a /api/... si tu backend cuelga de /api
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
      });
      return res.type('text/xml').send(vr.toString());
    }

    // ——— OpenAI: respuesta breve y natural ———
    let respuesta =
      locale.startsWith('es') ? 'Disculpa, no entendí eso.' : "Sorry, I didn’t catch that.";

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
              `Eres Amy, una asistente telefónica amable y concisa del negocio ${tenant.name ||
                ''}. Responde breve y natural. Recuerda: nunca leas enlaces; si hace falta, di "te lo envío por SMS".`,
          },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

      // ✅ Guardado robusto de tokens en ambos canales
      const usage = (completion as any).usage ?? {};

      const totalTokens =
        (typeof usage.total_tokens === 'number')
          ? usage.total_tokens
          : ( (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) );

      if (totalTokens > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
          VALUES
            ($1, 'tokens_openai', date_trunc('month', NOW()), $2),
            ($1, 'voz',           date_trunc('month', NOW()), $2)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, totalTokens]
        );
      }

    } catch (e) {
      console.warn('⚠️ OpenAI falló, usando fallback:', e);
    }

    // ——— Decidir si hay que ENVIAR SMS con link útil ———
    // 1) etiqueta [[SMS:tipo]]
    const tagMatch = respuesta.match(/\[\[SMS:(reservar|comprar|soporte|web)\]\]/i);
    let smsType: LinkType | null = tagMatch
      ? (tagMatch[1].toLowerCase() as LinkType)
      : null;

    // 2) usuario lo pidió
    if (!smsType && askedForSms(userInput)) {
      smsType = guessType(userInput);
      console.log('[VOICE/SMS] Usuario solicitó SMS → tipo inferido =', smsType);
    }

    // 3) el asistente lo prometió
    if (!smsType && didAssistantPromiseSms(respuesta)) {
      smsType = guessType(`${userInput} ${respuesta}`);
      console.log('[VOICE/SMS] Asistente prometió SMS → tipo inferido =', smsType);
    }

    // limpiar etiqueta del habla
    if (tagMatch) respuesta = respuesta.replace(tagMatch[0], '').trim();

    // ——— Guardar conversación ———
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

    // ——— Si hay que mandar SMS, buscamos link y lo enviamos ———
    if (smsType) {
      try {
        const synonyms: Record<LinkType, string[]> = {
          reservar: ['reservar', 'reserva', 'agendar', 'cita', 'turno', 'booking', 'appointment'],
          comprar: ['comprar', 'pagar', 'checkout', 'payment', 'pay'],
          soporte: ['soporte', 'support', 'ticket', 'ayuda'],
          web: ['web', 'sitio', 'pagina', 'página', 'home', 'website'],
        };

        const syns = synonyms[smsType];
        const likeAny = syns.map((w) => `%${w}%`);

        // placeholders con offsets correctos
        const base = 3;
        const inPlaceholders = syns.map((_, i) => `lower($${base + i})`).join(', ');
        const likeBase = base + syns.length;
        const likeClauses = likeAny
          .map((_, i) => `lower(tipo) LIKE lower($${likeBase + i})`)
          .join(' OR ');

        const sql = `
          SELECT id, tipo, nombre, url
          FROM links_utiles
          WHERE tenant_id = $1
            AND (
              lower(tipo) = lower($2)
              OR lower(tipo) IN (${inPlaceholders})
              OR ${likeClauses}
            )
          ORDER BY created_at DESC
          LIMIT 1
        `;

        const params = [tenant.id, smsType, ...syns, ...likeAny];
        const { rows: links } = await pool.query(sql, params);

        let chosen = links[0];

        if (!chosen) {
          const { rows: fallback } = await pool.query(
            `SELECT id, tipo, nombre, url
            FROM links_utiles
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
            [tenant.id]
          );
          chosen = fallback[0];
          console.log('[VOICE/SMS] Fallback link más reciente:', chosen);
        } else {
          console.log('[VOICE/SMS] Link por tipo encontrado:', chosen);
        }

        if (chosen?.url) {
          // ✅ valida que el número "from" sea SMS-capable (E.164 y configurado como SMS)
          const isE164 = (n?: string) => !!n && /^\+\d{7,15}$/.test(n);

          const smsFrom =
            (isE164(tenant.twilio_sms_number) ? tenant.twilio_sms_number : null) ??
            (isE164(tenant.twilio_voice_number) ? tenant.twilio_voice_number : null);

          if (!smsFrom) {
            console.warn('[VOICE/SMS] No hay número E.164 para SMS/voz en el tenant.');
            respuesta += locale.startsWith('es')
              ? ' No hay un número SMS configurado para enviar el enlace.'
              : ' There is no SMS-capable number configured to send the link.';
          } else {
            console.log(`[VOICE/SMS] Enviando SMS desde ${smsFrom} a ${fromNumber} → ${chosen.nombre}: ${chosen.url}`);

            const client = Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
            // ✅ no bloquear la llamada por el SMS
            client.messages.create({
              from: smsFrom,
              to: fromNumber,
              body: `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}`,
            })
            .then(() => {
              console.log('[VOICE/SMS] SMS enviado OK');
              // opcional: registra mensaje "system" asincrónico también sin await
              pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
                [tenant.id, `SMS enviado con link: ${chosen.nombre} → ${chosen.url}`, smsFrom]
              ).catch(console.error);
            })
            .catch((e) => {
              console.error('[VOICE/SMS] Falló SMS:', e?.code, e?.message || e);
            });

            respuesta += locale.startsWith('es')
              ? ' Te lo acabo de enviar por SMS.'
              : ' I just texted it to you.';
          }
        } else {
          console.warn('[VOICE/SMS] No hay links_utiles guardados para este tenant.');
          respuesta += locale.startsWith('es')
            ? ' No encontré un enlace registrado aún.'
            : " I couldn't find a saved link yet.";
        }
      } catch (e: any) {
        console.error('[VOICE/SMS] Error enviando SMS:', e?.code, e?.message, e?.moreInfo || e);
        respuesta += locale.startsWith('es')
          ? ' Hubo un problema al enviar el SMS.'
          : ' There was a problem sending the text.';
      }
    } else {
      console.log(
        '[VOICE/SMS] No se detectó condición para enviar SMS.',
        'userInput=', short(userInput),
        'respuesta=', short(respuesta)
      );
    }

    // ——— ¿Terminamos? ———
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    respuesta = formatTimesForLocale(respuesta, locale as any);

    // Hablar (sanitiza para evitar 13520)
    const speakOut = sanitizeForSay(respuesta);
    vr.say({ language: locale as any, voice: voiceName }, speakOut);
    vr.pause({ length: 1 });

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
