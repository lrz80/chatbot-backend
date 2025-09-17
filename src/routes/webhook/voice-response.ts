// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { cycleStartForNow } from '../../utils/billingCycle';
import { sendSMS, normalizarNumero } from '../../lib/senders/sms';

const router = Router();

// ———————————————————————————
//  Helpers de formato de hora / idioma / sanitización
// ———————————————————————————
function normalizeClockText(text: string, locale: string) {
  let s = text || '';
  const isUS = (locale || '').toLowerCase() === 'en-us';

  s = s
    .replace(/\bantes\s+del\s+meridiano\b/gi, 'am')
    .replace(/\bdespu[eé]s\s+del\s+meridiano\b/gi, 'pm')
    .replace(/\ba\.?\s*m\.?\b/gi, 'am')
    .replace(/\bp\.?\s*m\.?\b/gi, 'pm');

  s = s.replace(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*(am|pm)\b/gi, (_, h, mm, ap) => {
    const hNum = parseInt(h, 10) % 12;
    if (isUS) {
      const h12 = hNum === 0 ? 12 : hNum;
      return `${h12}:${mm} ${ap.toLowerCase()}`;
    }
    const h24 = (ap.toLowerCase() === 'pm') ? hNum + 12 : hNum;
    return `${h24.toString().padStart(2, '0')}:${mm}`;
  });

  s = s.replace(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/gi, (_, h, ap) => {
    const hNum = parseInt(h, 10) % 12;
    if (isUS) {
      const h12 = hNum === 0 ? 12 : hNum;
      return `${h12}:00 ${ap.toLowerCase()}`;
    }
    const h24 = (ap.toLowerCase() === 'pm') ? hNum + 12 : hNum;
    return `${h24.toString().padStart(2, '0')}:00`;
  });

  s = s.replace(/\b(1[0-2]|0?[1-9])\s*(?:a|hasta|-|–|—)\s*(1[0-2]|0?[1-9])\s*pm\b/gi, (_, h1, h2) => {
    if (isUS) {
      const a = (parseInt(h1,10)%12)||12;
      const b = (parseInt(h2,10)%12)||12;
      return `${a}:00 pm a ${b}:00 pm`;
    }
    const a24 = (parseInt(h1,10)%12)+12;
    const b24 = (parseInt(h2,10)%12)+12;
    return `${a24.toString().padStart(2,'0')}:00 a ${b24.toString().padStart(2,'0')}:00`;
  });
  s = s.replace(/\b(1[0-2]|0?[1-9])\s*(?:a|hasta|-|–|—)\s*(1[0-2]|0?[1-9])\s*am\b/gi, (_, h1, h2) => {
    if (isUS) {
      const a = (parseInt(h1,10)%12)||12;
      const b = (parseInt(h2,10)%12)||12;
      return `${a}:00 am a ${b}:00 am`;
    }
    const a24 = (parseInt(h1,10)%12);
    const b24 = (parseInt(h2,10)%12);
    return `${a24.toString().padStart(2,'0')}:00 a ${b24.toString().padStart(2,'0')}:00`;
  });

  if (isUS) {
    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) => {
      const h = parseInt(hh, 10);
      const ap = h >= 12 ? 'pm' : 'am';
      const h12 = (h % 12) || 12;
      return `${h12}:${mm} ${ap}`;
    });
  } else {
    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) =>
      `${parseInt(hh, 10).toString().padStart(2, '0')}:${mm}`
    );
    s = s
      .replace(/\b(am|pm)\b/gi, '')
      .replace(/\b(a\.?\s*m\.?|p\.?\s*m\.?)\b/gi, '')
      .replace(/\b(antes\s+del\s+meridiano|despu[eé]s\s+del\s+meridiano)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return s;
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
    .replace(/[*_`~^>#-]+/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

// ———————————————————————————
//  Detección de SMS + tipo de link
// ———————————————————————————
const askedForSms = (t: string) => {
  const s = (t || '').toLowerCase();
  return (
    /(\bsms\b|\bmensaje\b|\btexto\b|\bmand(a|e|alo)\b|\benv[ií]a(lo)?\b|\bp[aá]same\b|\bp[aá]salo\b|\btext\b|\btext me\b|\bmessage me\b)/i.test(s) &&
    /link|enlace|liga|url|p[aá]gina|web|reserv|agend|cita|turno|compr|pag|pago|checkout|soporte|support|precio|precios|tarifa|tarifas|pricing|rates/i.test(s)
  );
};

const didAssistantPromiseSms = (t: string) =>
  /\b(te lo (?:env[ií]o|enviar[eé]) por sms|te lo mando por sms|te lo envío por mensaje|te lo mando por mensaje|i'?ll text it to you|i'?ll send (it|the link) by text|i can text (it|you))\b/i.test(
    t || ''
  );

// ✅ aceptación aunque no diga "sms" (para ofertas previas)
const acceptedSms = (t: string) =>
  /\b(s[ií]|sí|si|ok|dale|va|claro|perfecto|por favor|please|yes|yep|yeah|sure|send it|env[ií]alo|m[aá]ndalo)\b/i.test(t || '');

type LinkType = 'reservar' | 'comprar' | 'soporte' | 'web';

// Heurística directa desde la pregunta del usuario
const inferOfferType = (t: string): LinkType | null => {
  const s = (t || '').toLowerCase();
  if (/(precio|precios|tarifa|tarifas|pricing|rates|membres[ií]a|planes|paquetes|cost(o|s)|cu[aá]nto|how much)/.test(s)) return 'comprar';
  if (/(reserv|agend|cita|turno|horari|schedule|class(es)?|clase|booking|appointment)/.test(s)) return 'reservar';
  if (/(soporte|support|ticket|help|ayuda)/.test(s)) return 'soporte';
  if (/(web|sitio|p[aá]gina|home|website|info)/.test(s)) return 'web';
  return null;
};

// Normaliza un texto corto para logs
const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

// ———————————————————————————
//  Firma de marca dinámica por tenant
// ———————————————————————————
async function getTenantBrand(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT COALESCE(
        NULLIF(TRIM(business_name), ''),
        NULLIF(TRIM(nombre_negocio), ''),
        NULLIF(TRIM(name), '')
      ) AS brand
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );
  const brand = (rows?.[0]?.brand || '').toString().trim();
  return brand || 'Amy';
}

// ———————————————————————————
//  Búsqueda de links por tipo (links_utiles) y fallback a voice_links
// ———————————————————————————
async function findLinkByType(tenantId: string, kind: LinkType) {
  const synonyms: Record<LinkType, string[]> = {
    // 👇 añadimos términos de precios aquí para cubrir "precios"
    reservar: ['reservar', 'reserva', 'agendar', 'cita', 'turno', 'booking', 'appointment', 'horario', 'horarios', 'schedule'],
    comprar: ['comprar', 'pagar', 'checkout', 'payment', 'pay', 'precio', 'precios', 'tarifa', 'tarifas', 'pricing', 'rates', 'membresía', 'membresia', 'membership', 'planes', 'paquetes'],
    soporte: ['soporte', 'support', 'ticket', 'ayuda'],
    web: ['web', 'sitio', 'pagina', 'página', 'home', 'website', 'info'],
  };

  const syns = synonyms[kind];
  const likeAny = syns.map((w) => `%${w}%`);

  const base = 3;
  const inPlaceholders = syns.map((_, i) => `lower($${base + i})`).join(', ');
  const likeBase = base + syns.length;
  const likeClauses = likeAny.map((_, i) => `lower(tipo) LIKE lower($${likeBase + i})`).join(' OR ');

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
  const params = [tenantId, kind, ...syns, ...likeAny];
  const { rows } = await pool.query(sql, params);
  if (rows[0]) return rows[0];

  // Fallback: lista corta desde voice_links (top 5)
  const { rows: vlinks } = await pool.query(
    `SELECT title, url
       FROM voice_links
      WHERE tenant_id = $1
      ORDER BY orden ASC, id ASC
      LIMIT 5`,
    [tenantId]
  );

  if (vlinks.length) {
    const bullets = vlinks.map((r: any, i: number) => `${i + 1}. ${r.title || 'Link'}: ${r.url}`).join('\n');
    return { nombre: 'Links útiles', url: null, bullets };
  }

  return null;
}

// ———————————————————————————
//  Handler
// ———————————————————————————
router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();

  const didNumber  = to.replace(/^tel:/, '');
  const callerRaw  = from.replace(/^tel:/, '');
  const callerE164 = normalizarNumero(callerRaw);

  const userInputRaw = (req.body.SpeechResult || '').toString();
  const userInput = userInputRaw.trim();

  const vr = new twiml.VoiceResponse();

  try {
    // 🧭 Tenant por DID de voz
    const tRes = await pool.query(
      `SELECT id, name, business_name, nombre_negocio,
              membresia_activa, membresia_inicio,
              twilio_sms_number, twilio_voice_number, messaging_service_sid
         FROM tenants
        WHERE twilio_voice_number = $1
        LIMIT 1`,
      [didNumber]
    );

    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    // 🔒 Membresía
    if (!tenant.membresia_activa) {
      vr.say({ voice: 'alice', language: 'es-ES' as any },
        'Tu membresía está inactiva. Por favor actualízala para continuar. ¡Gracias!'
      );
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    // 🎛️ Voice config
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

    // ——— ¿Hubo oferta de SMS en el turno previo? ———
    let previouslyOffered: LinkType | null = null;
    try {
      const { rows: prev } = await pool.query(
        `SELECT content
           FROM messages
          WHERE tenant_id = $1 AND canal = 'voz' AND role = 'assistant' AND from_number = $2
          ORDER BY timestamp DESC
          LIMIT 1`,
        [tenant.id, didNumber || 'sistema']
      );
      const lastAssistant = prev?.[0]?.content || '';
      const m = lastAssistant.match(/\[\[OFFER_SMS:(reservar|comprar|soporte|web)\]\]/i);
      if (m) previouslyOffered = m[1].toLowerCase() as LinkType;
    } catch {}

    // Primera vuelta: sin SpeechResult → saludo + gather
    if (!userInput) {
      const brand = await getTenantBrand(tenant.id);
      const initial = sanitizeForSay(`Hola, soy Amy de ${brand}. ¿En qué puedo ayudarte?`);
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

    // ——— OpenAI ———
    let respuesta = locale.startsWith('es') ? 'Disculpa, no entendí eso.' : "Sorry, I didn’t catch that.";
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      const brand = await getTenantBrand(tenant.id);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              `Eres Amy, una asistente telefónica amable y concisa del negocio ${brand}. Responde breve y natural. No leas URLs largas en voz. Cuando corresponda, ofrece enviar el enlace por SMS.`,
          },
          { role: 'user', content: userInput },
        ],
      });

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

      // Tokens → uso mensual
      const usage = (completion as any).usage ?? {};
      const totalTokens =
        typeof usage.total_tokens === 'number'
          ? usage.total_tokens
          : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

      const cicloInicio = cycleStartForNow(tenant.membresia_inicio);
      if (totalTokens > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'voz', $2::date, $3)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, cicloInicio, totalTokens]
        );
      }
    } catch (e) {
      console.warn('⚠️ OpenAI falló, usando fallback:', e);
    }

    // ——— Detección de intención SMS ———
    const tagMatch = respuesta.match(/\[\[SMS:(reservar|comprar|soporte|web)\]\]/i);
    let smsType: LinkType | null = tagMatch ? (tagMatch[1].toLowerCase() as LinkType) : null;

    // 1) Usuario pide SMS explícitamente
    if (!smsType && askedForSms(userInput)) {
      smsType = inferOfferType(userInput) || 'reservar';
      console.log('[VOICE/SMS] Usuario solicitó SMS → tipo inferido =', smsType);
    }

    // 2) Asistente lo prometió en la respuesta
    if (!smsType && didAssistantPromiseSms(respuesta)) {
      smsType = inferOfferType(`${userInput} ${respuesta}`) || 'reservar';
      console.log('[VOICE/SMS] Asistente prometió SMS → tipo inferido =', smsType);
    }

    // 3) Aceptación de una oferta previa (aunque no diga "sms")
    if (!smsType && previouslyOffered && acceptedSms(userInput)) {
      smsType = previouslyOffered;
      console.log('[VOICE/SMS] Usuario aceptó oferta previa → tipo =', smsType);
    }

    // limpia etiqueta de envío inmediato si existiera
    if (tagMatch) respuesta = respuesta.replace(tagMatch[0], '').trim();

    // ——— Propuesta PROACTIVA de SMS si hay link relevante ———
    // (Solo ofrece si NO acabamos de decidir enviar)
    let offeredNow: LinkType | null = null;
    if (!smsType && !previouslyOffered) {
      const offerKind = inferOfferType(userInput);
      if (offerKind) {
        const candidate = await findLinkByType(tenant.id, offerKind);
        if (candidate) {
          offeredNow = offerKind;
          const offerLine = locale.startsWith('es')
            ? ' Si quieres, te lo envío por SMS.'
            : ' If you’d like, I can text it to you.';
          respuesta += offerLine + ` [[OFFER_SMS:${offerKind}]]`;
        }
      }
    }

    // ——— Guardar conversación ———
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
      [tenant.id, userInput, callerE164 || 'anónimo']
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
      [tenant.id, respuesta, didNumber || 'sistema']
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voz', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(didNumber);

    // ——— Envío de SMS si corresponde ———
    if (smsType) {
      try {
        // Buscar link por tipo (y fallback a voice_links)
        const chosen = await findLinkByType(tenant.id, smsType);

        if (!chosen) {
          console.warn('[VOICE/SMS] No hay links para este tenant.');
          respuesta += locale.startsWith('es')
            ? ' No encontré un enlace registrado aún.'
            : " I couldn't find a saved link yet.";
        } else {
          const brand = await getTenantBrand(tenant.id);
          let body: string;

          if (chosen.url) {
            body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;
          } else {
            // bullets desde voice_links
            body = `Gracias por llamar. Te comparto los links:\n${chosen.bullets}\n— ${brand}`;
          }

          const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || '';
          const messagingServiceSid = tenant.messaging_service_sid || undefined;

          const toDest = callerE164;
          if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
            console.warn('[VOICE/SMS] Número destino inválido para SMS:', callerRaw, '→', toDest);
            // Nota: no añadimos texto extra a respuesta aquí porque ya se guardó arriba.
          } else if (!smsFrom && !messagingServiceSid) {
            console.warn('[VOICE/SMS] No hay from SMS-capable ni messaging_service_sid configurado.');
          } else if (smsFrom && smsFrom.startsWith('whatsapp:')) {
            console.warn('[VOICE/SMS] El número configurado es WhatsApp; no envía SMS.');
          } else {
            sendSMS({
              mensaje: body,
              destinatarios: [toDest],
              fromNumber: smsFrom || undefined,
              messagingServiceSid,
              tenantId: tenant.id,
              campaignId: null,
            }).then((n) => {
              console.log('[VOICE/SMS] sendSMS -> enviados =', n);
              pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                 VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
                [tenant.id, `SMS enviado con ${chosen.url ? 'link único' : 'lista de links'}.`, smsFrom || `svc:${messagingServiceSid}`]
              ).catch(console.error);
            }).catch((e) => {
              console.error('[VOICE/SMS] sendSMS ERROR:', e?.code, e?.message || e);
            });
          }
        }
      } catch (e: any) {
        console.error('[VOICE/SMS] Error enviando SMS:', e?.code, e?.message, e?.moreInfo || e);
      }
    } else {
      console.log(
        '[VOICE/SMS] No se envía SMS (ninguna condición de envío cumplida).',
        'prevOffered=', previouslyOffered, 'offeredNow=', offeredNow,
        'userInput=', short(userInput)
      );
    }

    // ——— ¿Terminamos? ———
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    // Normaliza horas y limpia meridiano/ampm ANTES de sanitizeForSay
    let speakResp = normalizeClockText(respuesta, locale as any);
    const speakOut = sanitizeForSay(speakResp);

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
        locale.startsWith('es') ? 'Gracias por tu llamada. ¡Hasta luego!' : 'Thanks for calling. Goodbye!'
      );
      vr.hangup();
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
    console.error('❌ Error en voice-response:', err);
    return res.sendStatus(500);
  }
});

export default router;
