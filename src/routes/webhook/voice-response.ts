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

// ===== Estado por llamada (en memoria) =====
type CallState = {
  awaiting?: boolean;  // esperando confirmación de envío
  pendingType?: 'reservar' | 'comprar' | 'soporte' | 'web' | null;
  awaitingNumber?: boolean; // esperando que nos dicte/marque un número
  altDest?: string | null;  // número alterno confirmado por el usuario (E.164)
  smsSent?: boolean;        // idempotencia: ya se envió SMS en esta llamada
};

const CALL_STATE = new Map<string, CallState>();

// ✅ TTL para limpiar memoria si Twilio no manda el último hit
const STATE_TTL_MS = 30 * 60 * 1000; // 30 min
const STATE_TIME = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [sid, t] of STATE_TIME.entries()) {
    if (now - t > STATE_TTL_MS) {
      CALL_STATE.delete(sid);
      STATE_TIME.delete(sid);
    }
  }
}, 10 * 60 * 1000);

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

// ——— Helpers para confirmar/capturar número destino ———
const maskForVoice = (n: string) =>
  (n || '')
    .replace(/^\+?(\d{0,3})\d{0,6}(\d{2})(\d{2})$/, (_, p, a, b) =>
      `+${p || ''} *** ** ${a} ${b}`
    );

const extractDigits = (t: string) => (t || '').replace(/\D+/g, '');
const isValidE164 = (n?: string | null) => !!n && /^\+\d{10,15}$/.test(n);

// ✅ recorte duro a 2 frases máximo antes de locutar
function twoSentencesMax(s: string) {
  const parts = (s || '').replace(/\s+/g, ' ').trim().split(/(?<=[\.\?\!])\s+/);
  return parts.slice(0, 2).join(' ').trim();
}

// ———————————————————————————
//  Detección de SMS + tipo de link
// ———————————————————————————
const askedForSms = (t: string) => {
  const s = (t || '').toLowerCase();
  const wantsSms =
    /(\bsms\b|\bmensaje\b|\btexto\b|\bmand(a|e|alo)\b|\benv[ií]a(lo)?\b|\btext\b|\btext me\b|\bmessage me\b)/i.test(s);
  if (!wantsSms) return false;
  const mentionsLink =
    /link|enlace|liga|url|p[aá]gina|web|reserv|agend|cita|turno|compr|pag|pago|checkout|soporte|support/i.test(s);
  return mentionsLink || true; // 👈 permite sin “link”
};

const didAssistantPromiseSms = (t: string) =>
  /\b(te lo (?:env[ií]o|enviar[eé]) por sms|te lo mando por sms|te lo envío por mensaje|te lo mando por mensaje|i'?ll text it to you|i'?ll send it by text)\b/i.test(
    t || ''
  );

type LinkType = 'reservar' | 'comprar' | 'soporte' | 'web';

const guessType = (t: string): LinkType => {
  const s = (t || '').toLowerCase();
  if (/(reserv|agend|cita|turno|booking|appointment)/.test(s)) return 'reservar';
  if (/(compr|pag|pago|checkout|buy|pay|payment)/.test(s)) return 'comprar';
  if (/(soporte|support|ticket|help|ayuda)/.test(s)) return 'soporte';
  if (/(web|sitio|p[aá]gina|home|website)/.test(s)) return 'web';
  return 'reservar';
};

const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

 // Confirmación del usuario para SMS
 const saidYes = (t: string) =>
   /\b(s[ií]|sí por favor|claro|dale|ok(?:ay)?|porfa|env[ií]alo|m[aá]ndalo|mándalo|hazlo|sí, envíalo|yes|yep|please do|send it|text it)\b/i.test(t || '');
 const saidNo = (t: string) =>
   /\b(no|no gracias|mejor no|luego|despu[eé]s|m[aá]s tarde|not now|don'?t)\b/i.test(t || '');


// ———————————————————————————
//  Marca dinámica del tenant (solo `name`)
// ———————————————————————————
async function getTenantBrand(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT NULLIF(TRIM(name), '') AS brand
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );
  const brand = (rows?.[0]?.brand || '').toString().trim();
  return brand || 'Amy';
}

async function enviarSmsConLink(
  tipo: LinkType,
  {
    tenantId,
    callerE164,
    callerRaw,
    smsFromCandidate,
    callSid,
    overrideDestE164, // 👈 NUEVO (opcional)
  }: {
    tenantId: string;
    callerE164: string | null;
    callerRaw: string;
    smsFromCandidate: string | null;
    callSid: string;
    overrideDestE164?: string | null;
  }
) {
  // 1) Buscar link útil por tipo (links_utiles) 
  const synonyms: Record<LinkType, string[]> = {
    reservar: ['reservar', 'reserva', 'agendar', 'cita', 'turno', 'booking', 'appointment'],
    comprar:  ['comprar', 'pagar', 'checkout', 'payment', 'pay', 'precio', 'precios', 'prices'],
    soporte:  ['soporte', 'support', 'ticket', 'ayuda', 'whatsapp', 'wa.me', 'whats'],
    web:      ['web', 'sitio', 'pagina', 'página', 'home', 'website', 'ubicacion', 'ubicación', 'location', 'mapa', 'maps', 'google maps'],
  };

  const syns = synonyms[tipo];
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
  const params = [tenantId, tipo, ...syns, ...likeAny];
  const { rows: linksByType } = await pool.query(sql, params);

  let chosen: { nombre?: string; url?: string } | null = linksByType[0] || null;

  let bulletsFromVoice: string | null = null;
  if (!chosen) {
    const { rows: vlinks } = await pool.query(
      `SELECT title, url
         FROM links_utiles
        WHERE tenant_id = $1
        ORDER BY orden ASC, id ASC
        LIMIT 5`,
      [tenantId]
    );
    if (vlinks.length > 0) {
      bulletsFromVoice = vlinks.map((r: any, i: number) => `${i + 1}. ${r.title || 'Link'}: ${r.url}`).join('\n');
    }
  }

  const brand = await getTenantBrand(tenantId);
  let body: string;
  if (chosen?.url) {
    body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;
  } else if (bulletsFromVoice) {
    body = `Gracias por llamar. Te comparto los links:\n${bulletsFromVoice}\n— ${brand}`;
  } else {
    throw new Error('No hay links_utiles configurados.');
  }

  const smsFrom = smsFromCandidate || '';
  const toDest = overrideDestE164 && isValidE164(overrideDestE164)
  ? overrideDestE164
  : callerE164;

  if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
    throw new Error(`Número destino inválido: ${callerRaw} → ${toDest}`);
  }
  if (!smsFrom) {
    throw new Error('No hay un número SMS-capable configurado.');
  }
  if (smsFrom.startsWith('whatsapp:')) {
    throw new Error('Número configurado es WhatsApp-only; no envía SMS.');
  }

  // 2) Enviar SMS
  const n = await sendSMS({
    mensaje: body,
    destinatarios: [toDest],
    fromNumber: smsFrom,
    tenantId,
    campaignId: null,
  });
  console.log('[VOICE/SMS] sendSMS -> enviados =', n);

  console.log('[VOICE][SMS_SENT]', JSON.stringify({
    callSid,
    sent: n,
    to: toDest
  }));

  // 3) Limpiar estado de la llamada y log en messages
  CALL_STATE.set(callSid, { awaiting: false, pendingType: null, smsSent: true }); // ✅ marca idempotencia
  STATE_TIME.set(callSid, Date.now());
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
    [tenantId, `SMS enviado con ${chosen?.url ? 'link único' : 'lista de links'}.`, smsFrom || 'sms']
  );
}

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

  const digits = (req.body.Digits || '').toString().trim();  // 👈 nuevo

  // UNA SOLA instancia de VoiceResponse
  const vr = new twiml.VoiceResponse();

  const callSid: string = (req.body.CallSid || '').toString();
  const state = CALL_STATE.get(callSid) || {};

  // ⬇️ LOG — lo que dijo el cliente
  console.log('[VOICE][USER]', JSON.stringify({
    callSid,
    from: callerE164 || callerRaw,
    digits,
    userInput
  }));

  try {
    // ✅ handler de silencio (cuando Twilio devuelve sin SpeechResult/Digits en turnos posteriores)
    if (!userInput && !digits && Object.prototype.hasOwnProperty.call(req.body, 'SpeechResult')) {
      const vrSilence = new twiml.VoiceResponse();
      vrSilence.say({ language: 'es-ES' as any, voice: 'alice' as any }, '¿Me lo repites, por favor?');
      vrSilence.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: 'es-ES' as any,
        speechTimeout: 'auto',
        timeout: 7,                 // 👈 añade
        actionOnEmptyResult: true,  // 👈 añade
      });
      STATE_TIME.set(callSid, Date.now()); // ✅ refresca TTL
      console.log('[VOICE][BOT]', JSON.stringify({
        callSid,
        to: didNumber,
        speakOut: '¿Me lo repites, por favor?'
      }));

      return res.type('text/xml').send(vrSilence.toString());
    }
    const tRes = await pool.query(
      `SELECT id, name,
              membresia_activa, membresia_inicio,
              twilio_sms_number, twilio_voice_number
         FROM tenants
        WHERE twilio_voice_number = $1
        LIMIT 1`,
      [didNumber]
    );

    const tenant = tRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
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

    // ===== Resultado de transferencia (Dial action) =====
    const isTransferCallback = (req.query && req.query.transfer === '1') || typeof req.body.DialCallStatus !== 'undefined';
    if (isTransferCallback) {
      const status = (req.body.DialCallStatus || '').toString(); // completed | no-answer | busy | failed | canceled
      console.log('[TRANSFER CALLBACK] DialCallStatus =', status);

      if (['no-answer','busy','failed','canceled'].includes(status)) {
        try {
          // Enviar link de WhatsApp por SMS (tipo 'soporte' con sinónimos de whatsapp)
          await enviarSmsConLink('soporte', {
            tenantId: tenant.id,
            callerE164,
            callerRaw,
            smsFromCandidate: tenant.twilio_sms_number || tenant.twilio_voice_number || '',
            callSid,
          });
          vr.say({ language: locale as any, voice: voiceName },
                'No se pudo completar la transferencia. Te envié el WhatsApp por SMS. ¿Algo más?');
        } catch (e) {
          console.error('[TRANSFER SMS FALLBACK] Error:', e);
          vr.say({ language: locale as any, voice: voiceName },
                'No se pudo completar la transferencia. Si quieres, te envío el WhatsApp por SMS. Di "sí" o pulsa 1.');
          CALL_STATE.set(callSid, { ...state, awaiting: true, pendingType: 'soporte' });
        }

        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: locale as any,
          speechTimeout: 'auto',
          timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
          actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
        });
        console.log('[VOICE][BOT]', JSON.stringify({
          callSid,
          to: didNumber,
          speakOut: 'No se pudo completar la transferencia...'
        }));

        return res.type('text/xml').send(vr.toString());
      }

      // Si fue "completed", simplemente retomamos flujo normal (no respondemos nada especial)
    }

    // Primera vuelta: sin SpeechResult → saludo + menú + gather
    const isFirstTurn = !CALL_STATE.has(callSid) && !userInput && !digits;

    if (isFirstTurn) {
      const brand = await getTenantBrand(tenant.id);

      const gather = vr.gather({
        input: ['dtmf', 'speech'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        bargeIn: true,
        actionOnEmptyResult: true,
        timeout: 4
      });

      gather.say(
        { language: locale as any, voice: voiceName },
        `Hola, soy Amy de ${brand}. ¿En qué puedo ayudarte?
        Marca 1 para precios, 2 para horarios, 3 para ubicación, 4 para hablar con un representante.`
      );

      CALL_STATE.set(callSid, { awaiting: false, pendingType: null, smsSent: false });
      STATE_TIME.set(callSid, Date.now());
      return res.type('text/xml').send(vr.toString());
    }

    // ✅ FAST-PATH: confirmación de SMS sin pasar por OpenAI
    let earlySmsType: LinkType | null = null;

    // Caso A: venías esperando confirmación por estado y dijo “sí/1”
    if (state.awaiting && (saidYes(userInput) || digits === '1')) {
      earlySmsType = (state.pendingType || guessType(userInput)) as LinkType;
      CALL_STATE.set(callSid, { ...state, awaiting: false, pendingType: null });
    }

    // Caso B: último turno marcó <SMS_PENDING:...> y ahora dijo “sí/1”
    if (!earlySmsType) {
      const { rows: lastAssistantRows } = await pool.query(
        `SELECT content
          FROM messages
          WHERE tenant_id = $1 AND canal = 'voz' AND role = 'assistant' AND from_number = $2
          ORDER BY timestamp DESC LIMIT 1`,
        [tenant?.id, didNumber || 'sistema']
      );
      const lastAssistantText: string = lastAssistantRows?.[0]?.content || '';
      const pendingMatch = lastAssistantText.match(/<SMS_PENDING:(reservar|comprar|soporte|web)>/i);
      if (pendingMatch && (saidYes(userInput) || digits === '1')) {
        earlySmsType = pendingMatch[1].toLowerCase() as LinkType;
      }
    }

    if (earlySmsType) {
      await enviarSmsConLink(earlySmsType, {
        tenantId: tenant.id,
        callerE164,
        callerRaw,
        smsFromCandidate: tenant.twilio_sms_number || tenant.twilio_voice_number || '',
        callSid,
        overrideDestE164: (state.altDest && isValidE164(state.altDest)) ? state.altDest : undefined,
      });
      const ok = locale.startsWith('es')
        ? 'Listo, te envié el enlace por SMS. ¿Algo más?'
        : 'Done, I just texted you the link. Anything else?';

      vr.say({ language: locale as any, voice: voiceName }, ok);
      vr.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
        actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
      });

      // Guarda conversación mínima del fast-path
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
        VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
        [tenant.id, userInput, callerE164 || 'anónimo']
      );
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
        VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
        [tenant.id, ok, didNumber || 'sistema']
      );
      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, created_at)
        VALUES ($1, 'voz', NOW())`,
        [tenant.id]
      );

      await incrementarUsoPorNumero(didNumber);
      STATE_TIME.set(callSid, Date.now());

      return res.type('text/xml').send(vr.toString());
    }

    // ===== IVR simple por dígito (1/2/3/4) =====
    if (digits && !state.awaiting) {
      // Contenidos hablados (ajústalos a tu negocio)
      const PRECIOS   = 'Nuestros precios principales: corte 25 dólares, color 60, paquete 80.';
      const HORARIOS  = 'Abrimos de lunes a sábado de 9 a 18 horas.';
      const UBICACION = 'Estamos en Avenida Siempre Viva 742, Colonia Centro.';

      // Número de representante E.164 si quieres transferir (o deja null)
      const REPRESENTANTE_NUMBER = '+15551234567'; // ← pon aquí tu número de agente o null

      // Helper: ofrece SMS y setea el pendingType según la opción
      const offerSms = (tipo: LinkType) => {
        const ask = locale.startsWith('es')
          ? '¿Quieres que te lo envíe por SMS? Di "sí" o pulsa 1.'
          : 'Do you want me to text it to you? Say "yes" or press 1.';
        vr.say({ language: locale as any, voice: voiceName }, ask);
        CALL_STATE.set(callSid, { ...state, awaiting: true, pendingType: tipo });
      };

      switch (digits) {
        case '1': { // precios → mapeamos a 'comprar' (por “precios/checkout”)
          vr.say({ language: locale as any, voice: voiceName }, PRECIOS);
          offerSms('comprar');
          break;
        }
        case '2': { // horarios → mapeamos a 'web' (típico link informativo)
          vr.say({ language: locale as any, voice: voiceName }, HORARIOS);
          offerSms('web');
          break;
        }
        case '3': { // ubicación → mapeamos a 'web' (link de Google Maps)
          vr.say({ language: locale as any, voice: voiceName }, UBICACION);
          offerSms('web');
          break;
        }
        case '4': { // representante
          if (REPRESENTANTE_NUMBER) {
            vr.say({ language: locale as any, voice: voiceName }, 'Te comunico con un representante. Un momento, por favor.');
            const dial = vr.dial({
              action: '/webhook/voice-response?transfer=1', // ← volverá aquí al colgar/resultado
              method: 'POST',
              timeout: 20, // segundos para contestar
            });
            dial.number(REPRESENTANTE_NUMBER);
            return res.type('text/xml').send(vr.toString());
          } else {
            vr.say({ language: locale as any, voice: voiceName },
                  'En breve te atenderá un representante. Si prefieres, te envío nuestro WhatsApp por SMS.');
            // para 4, si no se puede transferir, también ofrece SMS de WhatsApp → 'soporte'
            offerSms('soporte');
          }
          break;
        }
        default: {
          vr.say({ language: locale as any, voice: voiceName }, 'No reconocí esa opción.');
        }
      }

      // Re-ofrecer menú y conversación (say DENTRO del gather)
      const repGather = vr.gather({
        input: ['dtmf','speech'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });
      repGather.say(
        { language: locale as any, voice: voiceName },
        '¿Necesitas algo más? Marca 1 precios, 2 horarios, 3 ubicación, 4 representante, o dime en qué te ayudo.'
      );
      return res.type('text/xml').send(vr.toString());
    }

    // ——— OpenAI ———
    let respuesta = locale.startsWith('es') ? 'Disculpa, no entendí eso.' : "Sorry, I didn’t catch that.";
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      const brand = await getTenantBrand(tenant.id);

      // ✅ timeout de 6s para evitar cuelgues
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              `Eres Amy, una asistente telefónica amable y concisa del negocio ${brand}. Responde breve y natural. Nunca leas enlaces en voz. No prometas enviar SMS a menos que el usuario lo pida explícitamente.`,
          },
          { role: 'user', content: userInput },
        ],
      }, { signal: controller.signal as any });
      clearTimeout(timer);

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

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

        // ¿El turno anterior dejó un SMS pendiente?
        const { rows: lastAssistantRows } = await pool.query(
          `SELECT content
            FROM messages
            WHERE tenant_id = $1
              AND canal = 'voz'
              AND role = 'assistant'
              AND from_number = $2
            ORDER BY timestamp DESC
            LIMIT 1`,
          [tenant.id, didNumber || 'sistema']
        );
        const lastAssistantText: string = lastAssistantRows?.[0]?.content || '';
        const pendingMatch = lastAssistantText.match(/<SMS_PENDING:(reservar|comprar|soporte|web)>/i);

    // ——— Decidir si hay que ENVIAR SMS con link útil ———
    const tagMatch = respuesta.match(/\[\[SMS:(reservar|comprar|soporte|web)\]\]/i);
    let smsType: LinkType | null = tagMatch ? (tagMatch[1].toLowerCase() as LinkType) : null;

    // Evita que el tag aparezca en la locución
    if (tagMatch) respuesta = respuesta.replace(tagMatch[0], '').trim();

    // Confirmación diferida: si había pendiente y el usuario dijo "sí"
    if (!smsType && state.awaiting && (saidYes(userInput) || digits === '1')) {
      smsType = (state.pendingType || guessType(userInput)) as LinkType;
      console.log('[VOICE/SMS] Confirmación por estado → tipo =', smsType);
      state.awaiting = false;
      state.pendingType = null;
      CALL_STATE.set(callSid, state);
    }
    // Si rechazó, no enviamos
    if (!smsType && state.awaiting && (saidNo(userInput) || digits === '2')) {
      console.log('[VOICE/SMS] Usuario rechazó el SMS (estado).');
      state.awaiting = false;
      state.pendingType = null;
      CALL_STATE.set(callSid, state);
    }

    if (!smsType && askedForSms(userInput)) {
      smsType = guessType(userInput);
      console.log('[VOICE/SMS] Usuario solicitó SMS → tipo inferido =', smsType);
    }

    // Si el asistente "prometió" enviar SMS:
    if (!smsType && didAssistantPromiseSms(respuesta)) {
      const pendingType = guessType(`${userInput} ${respuesta}`);

      // Caso inmediato: usuario ya dijo "sí" o pulsó 1
      if (saidYes(userInput) || digits === '1') {
        smsType = pendingType as LinkType;
        console.log('[VOICE/SMS] Promesa + "sí/1" inmediato → tipo =', smsType);
      } else if (!saidNo(userInput) && digits !== '2') {
        // Pedimos confirmación y guardamos estado para el próximo turno
        const ask = locale.startsWith('es')
          ? '¿Quieres que te lo envíe por SMS? Di "sí" o pulsa 1 para enviarlo.'
          : 'Do you want me to text it to you? Say "yes" or press 1 to send it.';
        respuesta = `${respuesta} ${ask} <SMS_PENDING:${pendingType}>`.trim();
        CALL_STATE.set(callSid, { awaiting: true, pendingType });
      }
    }

    console.log('[VOICE/SMS] dbg', {
      awaiting: state.awaiting,
      pendingType: state.pendingType,
      digits,
      saidYes: saidYes(userInput),
      saidNo: saidNo(userInput),
      tagMatch: !!tagMatch,
      pendingMatch: !!pendingMatch,
      askedForSms: askedForSms(userInput),
      smsType,
    });

    // ——— Confirmación/Captura de número destino antes de enviar ———
    if (smsType) {
      // número preferido: alterno confirmado > callerE164
      const preferred = (state.altDest && isValidE164(state.altDest)) ? state.altDest : callerE164;

      // si el usuario ya dijo explícitamente "sí" o pulsó 1 en este turno, no bloqueamos
      const thisTurnYes = saidYes(userInput) || digits === '1';

      if (!thisTurnYes) {
        // si no tenemos número válido, pedirlo
        if (!isValidE164(preferred)) {
          const askNum = locale.startsWith('es')
            ? '¿A qué número te lo envío? Dímelo con el código de país o márcalo ahora.'
            : 'What number should I text? Please include country code or key it in now.';
          // marcar que esperamos número
          CALL_STATE.set(callSid, { ...state, awaitingNumber: true, pendingType: smsType });
          vr.say({ language: locale as any, voice: voiceName }, askNum);
          vr.gather({
            input: ['speech','dtmf'] as any,
            numDigits: 15,
            action: '/webhook/voice-response',
            method: 'POST',
            language: locale as any,
            speechTimeout: 'auto',
            timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
            actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
          });
          return res.type('text/xml').send(vr.toString());
        }

        // tenemos un número, pedir confirmación rápida
        const confirm = locale.startsWith('es')
          ? `Te lo envío al ${maskForVoice(preferred)}. Di "sí" o pulsa 1 para confirmar, o dicta otro número.`
          : `I'll text ${maskForVoice(preferred)}. Say "yes" or press 1 to confirm, or say another number.`;
        CALL_STATE.set(callSid, { ...state, awaiting: true, awaitingNumber: true, pendingType: smsType });
        vr.say({ language: locale as any, voice: voiceName }, confirm);
        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 15,
          action: '/webhook/voice-response',
          method: 'POST',
          language: locale as any,
          speechTimeout: 'auto',
          timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
          actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
        });
        return res.type('text/xml').send(vr.toString());
      }

      // Si thisTurnYes === true, seguimos abajo al bloque de envío
    }

    // ——— Si hay que mandar SMS ———
    if (smsType) {
      // ✅ evita doble envío si el webhook se reintenta
      if (state.smsSent) {
        console.log('[VOICE/SMS] SMS ya enviado en esta llamada, se omite reintento.');
      } else {
      try {
        const synonyms: Record<LinkType, string[]> = {
          reservar: ['reservar', 'reserva', 'agendar', 'cita', 'turno', 'booking', 'appointment'],
          comprar:  ['comprar', 'pagar', 'checkout', 'payment', 'pay', 'precio', 'precios', 'prices'],
          soporte:  ['soporte', 'support', 'ticket', 'ayuda', 'whatsapp', 'wa.me', 'whats'],
          web:      ['web', 'sitio', 'pagina', 'página', 'home', 'website', 'ubicacion', 'ubicación', 'location', 'mapa', 'maps', 'google maps'],
        };

        const syns = synonyms[smsType];
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
        const params = [tenant.id, smsType, ...syns, ...likeAny];
        const { rows: linksByType } = await pool.query(sql, params);

        let chosen: { nombre?: string; url?: string } | null = linksByType[0] || null;

        // Fallback a lista desde links_utiles
        let bulletsFromVoice: string | null = null;
        if (!chosen) {
          const { rows: vlinks } = await pool.query(
            `SELECT nombre AS title, url
              FROM links_utiles
              WHERE tenant_id = $1
              ORDER BY id ASC
              LIMIT 5`,
            [tenant.id]
          );
          if (vlinks.length > 0) {
            bulletsFromVoice = vlinks
              .map((r: any, i: number) => `${i + 1}. ${r.title || 'Link'}: ${r.url}`)
              .join('\n');
          }
        }

        if (!chosen && !bulletsFromVoice) {
          console.warn('[VOICE/SMS] No hay links_utiles ni voice_links para este tenant.');
          respuesta += locale.startsWith('es')
            ? ' No encontré un enlace registrado aún.'
            : " I couldn't find a saved link yet.";
        } else {
          const brand = await getTenantBrand(tenant.id);
          let body: string;

          if (chosen?.url) {
            body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;
          } else {
            body = `Gracias por llamar. Te comparto los links:\n${bulletsFromVoice}\n— ${brand}`;
          }

          const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || '';

          // elegir destino final: altDest confirmado o callerE164
          const override = (state.altDest && isValidE164(state.altDest)) ? state.altDest : null;
          const toDest = override || callerE164;

          console.log('[VOICE/SMS] SENDING', {
            smsFrom,
            toDest,
            callerRaw,
            callSid,
            tenantId: tenant.id
          });

          if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
            console.warn('[VOICE/SMS] Número destino inválido para SMS:', callerRaw, '→', toDest);
            respuesta += locale.startsWith('es')
              ? ' No pude validar tu número para enviarte el SMS.'
              : ' I could not validate your number to text you.';
          } else if (!smsFrom) {
            console.warn('[VOICE/SMS] No hay un número SMS-capable configurado.');
            respuesta += locale.startsWith('es')
              ? ' No hay un número SMS configurado para enviar el enlace.'
              : ' There is no SMS-capable number configured to send the link.';
          } else if (smsFrom && smsFrom.startsWith('whatsapp:')) {
            console.warn('[VOICE/SMS] El número configurado es WhatsApp; no envía SMS.');
            respuesta += locale.startsWith('es')
              ? ' El número configurado es WhatsApp y no puede enviar SMS.'
              : ' The configured number is WhatsApp-only and cannot send SMS.';
          } else {
            sendSMS({
              mensaje: body,
              destinatarios: [toDest],
              fromNumber: smsFrom || undefined,
              tenantId: tenant.id,
              campaignId: null,
            })
              .then((n) => {
                console.log('[VOICE/SMS] sendSMS -> enviados =', n);
                // ✅ limpia/actualiza estado + marca smsSent
                CALL_STATE.set(callSid, { awaiting: false, pendingType: null, smsSent: true });
                STATE_TIME.set(callSid, Date.now());
                pool.query(
                  `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                   VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
                  [tenant.id, `SMS enviado con ${chosen?.url ? 'link único' : 'lista de links'}.`, smsFrom || 'sms']
                ).catch(console.error);
              })
              .catch((e) => {
                console.error('[VOICE/SMS] sendSMS ERROR:', e?.code, e?.message || e);
              });

            respuesta += locale.startsWith('es')
              ? ' Te lo acabo de enviar por SMS.'
              : ' I just texted it to you.';
          }
        }
      } catch (e: any) {
        console.error('[VOICE/SMS] Error enviando SMS:', e?.code, e?.message, e?.moreInfo || e);
        respuesta += locale.startsWith('es')
          ? ' Hubo un problema al enviar el SMS.'
          : ' There was a problem sending the text.';
      }
      } // <- fin anti-doble envío
    } else {
      console.log('[VOICE/SMS] No se detectó condición para enviar SMS.', 'userInput=', short(userInput), 'respuesta=', short(respuesta));
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

    // ——— ¿Terminamos? ———
    const fin = /(gracias|eso es todo|nada más|nada mas|bye|ad[ií]os)/i.test(userInput);

    // ✅ recorte a 2 frases y normalización de horas antes de locutar
    respuesta = twoSentencesMax(respuesta);
    respuesta = normalizeClockText(respuesta, locale as any);
    const speakOut = sanitizeForSay(respuesta);

    // ⬇️ LOG — lo que dirá el bot (lo que Twilio locuta)
    console.log('[VOICE][BOT]', JSON.stringify({
      callSid,
      to: didNumber,
      speakOut
    }));

    if (!fin) {
      const contGather = vr.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: locale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });
      contGather.say({ language: locale as any, voice: voiceName }, speakOut);
    } else {
      CALL_STATE.delete(callSid);
      STATE_TIME.delete(callSid);
      vr.say({ language: locale as any, voice: voiceName },
            locale.startsWith('es') ? 'Gracias por tu llamada. ¡Hasta luego!' : 'Thanks for calling. Goodbye!');
      vr.hangup();
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
  console.error('❌ Error en voice-response:', err);
  const vrErr = new twiml.VoiceResponse();
  vrErr.say({ language: 'es-ES', voice: 'alice' },
    'Perdón, hubo un problema. ¿Quieres que te envíe la información por SMS? Di sí o pulsa 1.');
  vrErr.gather({
    input: ['speech','dtmf'] as any,
    numDigits: 1,
    action: '/webhook/voice-response', // 🔁 ajusta si usas /api
    method: 'POST',
    language: 'es-ES',
    speechTimeout: 'auto',
  });
  return res.type('text/xml').send(vrErr.toString());  // ✅ mantener la llamada viva
}
});

export default router;
