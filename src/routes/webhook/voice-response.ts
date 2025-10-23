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
  lang?: 'es-ES' | 'en-US' | 'pt-BR';
  turn?: number;
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

//  Detección de SMS + tipo de link
const askedForSms = (t: string) => {
  const s = (t || '').toLowerCase();
  const wantsSms =
    /(\bsms\b|\bmensaje\b|\btexto\b|\bmand(a|e|alo)\b|\benv[ií]a(lo)?\b|\btext\b|\btext me\b|\bmessage me\b)/i.test(s);
  if (!wantsSms) return false;
  const mentionsLink =
    /link|enlace|liga|url|p[aá]gina|web|reserv|agend|cita|turno|compr|pag|pago|checkout|soporte|support/i.test(s);
  return mentionsLink || true; // 👈 permite sin “link”
};

const didAssistantPromiseSms = (t: string) => {
  const s = normTxt(t);
  return /\b(te lo envio por sms|te lo mand(o|are) por sms|te lo envio por mensaje|te lo mando por mensaje|ill text it to you|ill send it by text)\b/u.test(s);
};

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

function normTxt(t: string) {
  return (t || '')
    .normalize('NFD')                  // separa acentos
    .replace(/[\u0300-\u036f]/g, '')  // quita acentos
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')// quita puntuación
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Confirmación del usuario para SMS
const saidYes = (t: string) => {
 const s = normTxt(t);
 // cubre: si, si por favor, claro, dale, ok/okay, porfa, envialo, mandalo, hazlo, yes, yep, please do, send it, text it
 return /\b(si|si por favor|claro|dale|ok|okay|porfa|envialo|mandalo|hazlo|yes|yep|please do|send it|text it)\b/u.test(s);
};

const saidNo = (t: string) => {
  const s = normTxt(t);
  // cubre: no, no gracias, mejor no, luego, despues, mas tarde, not now, don't
  return /\b(no|no gracias|mejor no|luego|despues|mas tarde|not now|dont)\b/u.test(s);
};

//  Marca dinámica del tenant (solo `name`)
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
  const syns = LINK_SYNONYMS[tipo];
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

  // ⛔ Solo un link; si no hay, error
  if (!chosen?.url) {
    throw new Error('No hay links_utiles configurados para el tipo solicitado.');
  }

  const brand = await getTenantBrand(tenantId);
  const body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;

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

  console.log('[VOICE/SMS] DEBUG about to send', {
    tipo,
    toDest,
    smsFrom,
    tenantId,
    callSid,
    chosen
  });

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
  CALL_STATE.set(callSid, { ...(CALL_STATE.get(callSid) || {}), awaiting: false, pendingType: null, smsSent: true }); // ✅ marca idempotencia
  STATE_TIME.set(callSid, Date.now());
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
    [tenantId, 'SMS enviado con link único.', smsFrom || 'sms']
  );
}

//  Snippet desde prompt (sin DB extra)
async function snippetFromPrompt({
  topic,            // 'precios' | 'horarios' | 'ubicacion' | 'pagos'
  cfg,
  locale,
  brand,
}: {
  topic: 'precios' | 'horarios' | 'ubicacion' | 'pagos',
  cfg: any,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  brand: string,
}): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const sys = `
Eres Amy, asistente del negocio ${brand}.
Usa EXCLUSIVAMENTE la información en estas dos fuentes:
1) SYSTEM_PROMPT DEL NEGOCIO:
${(cfg.system_prompt || '').toString().trim()}

2) INFO_CLAVE DEL NEGOCIO:
${(cfg.info_clave || '').toString().trim()}

REGLAS DE RESPUESTA:
- Devuelve 1-2 frases MÁXIMO, aptas para locución telefónica.
- NO incluyas URLs ni digas "te envío link" (eso se ofrece fuera).
- NO inventes datos: si no hay dato explícito en lo anterior, di:
  "${locale.startsWith('es') ? 'No tengo ese dato exacto aquí.' : 'I don’t have that exact detail here.'}"
- Para HORARIOS, formatea horas natural (ej. "de 9 a 18"). 
- Para PRECIOS, sólo menciona montos si aparecen literalmente en las fuentes.
- Mantén el tono breve, claro y natural.`;

  const user = `Dame un breve resumen de ${topic} (máx 2 frases), usando sólo lo provisto.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  let text = (completion.choices[0]?.message?.content || '').trim();
  if (!text) {
    text = locale.startsWith('es')
      ? 'No tengo ese dato exacto aquí.'
      : 'I don’t have that exact detail here.';
  }
  console.log('[VOICE][SNIPPET]', JSON.stringify({ topic, brand, locale, text }));
  return text;
}

//  Helper global: ofrecer SMS + setear estado
function offerSms(
  vr: twiml.VoiceResponse,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  voiceName: any,
  callSid: string,
  state: CallState,
  tipo: LinkType
) {
  const ask = locale.startsWith('es')
    ? '¿Quieres que te lo envíe por SMS? Di "sí" o pulsa 1.'
    : 'Do you want me to text it to you? Say "yes" or press 1.';

  const gather = vr.gather({
    input: ['speech','dtmf'] as any,
    numDigits: 1,
    action: '/webhook/voice-response',
    method: 'POST',
    language: locale as any,
    speechTimeout: 'auto',
    timeout: 7,
    actionOnEmptyResult: true,
    bargeIn: true,
    // 👇 ayuda al ASR a captar “sí/yes/1”
    hints: locale.startsWith('es') ? 'sí, si, uno, 1' : 'yes, one, 1',
  });

  gather.say({ language: locale as any, voice: voiceName }, ask);

  CALL_STATE.set(callSid, { ...state, awaiting: true, pendingType: tipo });
  STATE_TIME.set(callSid, Date.now());

  // 👉 log del prompt de confirmación SMS
  logBotSay({ callSid, to: 'ivr', text: ask, lang: locale, context: `offer-sms:${tipo}` });
}

function playMainMenu(
  vr: twiml.VoiceResponse,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  voiceName: any,
  brand: string,
  callSid?: string,   // 👈 NUEVO
  toNumber?: string   // 👈 NUEVO
) {
  const gather = vr.gather({
    input: ['dtmf','speech'] as any,
    numDigits: 1,
    action: '/webhook/voice-response',
    method: 'POST',
    language: locale as any,
    speechTimeout: 'auto',
    bargeIn: true,
    actionOnEmptyResult: true,
    timeout: 4,
  });

  const text = locale.startsWith('es')
    ? `¿En qué puedo ayudarte? Marca 1 para precios, 2 para horarios, 3 para ubicación, 4 para hablar con un representante.`
    : `How can I help? Press 1 for prices, 2 for hours, 3 for location, 4 to speak with a representative.`;

  const line = locale.startsWith('es')
    ? `Hola, soy Amy de ${brand}. ${text}`
    : `Hi, I'm Amy from ${brand}. ${text}`;

  gather.say({ language: locale as any, voice: voiceName }, line);

  // 👉 Log exacto de lo que locutas en el menú
  logBotSay({ callSid: callSid || 'N/A', to: toNumber || 'ivr', text: line, lang: locale, context: 'menu' });
}

// --- Selección de idioma inicial ---
function introByLanguage(selected?: string) {
  const vr = new twiml.VoiceResponse();

  if (selected === 'es') {
    // Intro en español y pasamos al flujo principal en ES
    vr.say({ language: 'es-ES', voice: 'alice' }, 'Hola, soy Amy de Synergy Zone. Continuamos en español.');
    vr.redirect('/webhook/voice-response?lang=es');
    return vr.toString();
  }

  // Intro por defecto en inglés con opción a marcar 2 o decirlo
  const g = vr.gather({
    input: ['dtmf','speech'] as any,   // 👈 ahora también voz
    numDigits: 1,
    timeout: 7,
    language: 'en-US' as any,
    speechTimeout: 'auto',
    hints: 'spanish, español, dos, two, 2',  // 👈 ayuda al ASR
    action: '/webhook/voice-response/lang',
    method: 'POST',
    actionOnEmptyResult: true,
    bargeIn: true
  });

  // Prompt DENTRO del Gather
  g.say({ language: 'en-US' as any, voice: 'alice' },
    'Hi, this is Amy from Synergy Zone. For Spanish, press two or say “Spanish”.');

  return vr.toString();
}

// ——— LOG HELPERS ———
function logUserAsk({
  callSid, from, digits, userInput, lang, rawBody
}: {
  callSid: string; from: string; digits?: string; userInput?: string; lang?: string; rawBody?: any;
}) {
  console.log('[VOICE][ASK]', JSON.stringify({
    callSid, from, lang, digits: digits || '', text: (userInput || '').trim(),
    // opcional: quita si no quieres payload completo
    // rawTwilio: rawBody
  }));
}

function logBotSay({
  callSid, to, text, lang, context
}: {
  callSid: string; to: string; text: string; lang?: string; context?: string;
}) {
  console.log('[VOICE][SAY]', JSON.stringify({
    callSid, to, lang, speakOut: text, ctx: context || ''
  }));
}

const LINK_SYNONYMS: Record<LinkType, string[]> = {
  reservar: ['reservar', 'reserva', 'agendar', 'cita', 'turno', 'booking', 'appointment'],
  comprar:  ['comprar', 'pagar', 'checkout', 'payment', 'pay', 'precio', 'precios', 'prices'],
  soporte:  ['soporte', 'support', 'ticket', 'ayuda', 'whatsapp', 'wa.me', 'whats'],
  web:      ['web', 'sitio', 'pagina', 'página', 'home', 'website', 'ubicacion', 'ubicación', 'location', 'mapa', 'maps', 'google maps'],
};

function coerceSpeechToDigit(s: string): '1'|'2'|'3'|'4'|undefined {
  const w = (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();

  // Palabras clave → dígitos
  if (/\b(precio|precios|tarifa|tarifas|price|prices|pagar|pago|checkout|buy|pay|payment)\b/u.test(w)) return '1';
  if (/\b(horario|horarios|hours|schedule|open|close|abren|cierran)\b/u.test(w)) return '2';
  if (/\b(ubicacion|ubicación|direccion|dirección|address|location|mapa|maps|google maps)\b/u.test(w)) return '3';
  if (/\b(representante|humano|agente|persona|operator|representative)\b/u.test(w)) return '4';

  // Números en texto
  if (/^(1|one|uno)\b/u.test(w)) return '1';
  if (/^(2|two|dos)\b/u.test(w)) return '2';
  if (/^(3|three|tres)\b/u.test(w)) return '3';
  // Twilio a veces transcribe "four" como "for."
  if (/^(4|four|for)\b/u.test(w)) return '4';

  return undefined;
}

router.post('/lang', async (req: Request, res: Response) => {
  const rawDigits = (req.body.Digits || '').toString().trim();
  const speech = (req.body.SpeechResult || '').toString().toLowerCase().trim();

  console.log('[VOICE][LANG]', JSON.stringify({
    digits: rawDigits,
    speech,
    bodyKeys: Object.keys(req.body || {})
  }));

  // Coaccionamos también la voz a "2" si dice "dos"/"spanish"/"español"
  let chosen: 'en' | 'es' = 'en';
  if (rawDigits === '2') {
    chosen = 'es';
  } else if (/(spanish|español|dos|\b2\b)/i.test(speech)) {
    chosen = 'es';
  }

  const vr = new twiml.VoiceResponse();
  if (chosen === 'es') {
    vr.say({ language: 'es-ES', voice: 'alice' }, 'Has seleccionado español.');
    vr.redirect('/webhook/voice-response?lang=es');
  } else {
    vr.say({ language: 'en-US', voice: 'alice' }, 'Continuing in English.');
    vr.redirect('/webhook/voice-response?lang=en');
  }

  return res.type('text/xml').send(vr.toString());
});

//  Handler
router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();

  const didNumber  = to.replace(/^tel:/, '');
  const callerRaw  = from.replace(/^tel:/, '');
  const callerE164 = normalizarNumero(callerRaw);

  const userInputRaw = (req.body.SpeechResult || '').toString();
  const userInput = userInputRaw.trim();

  let digits = (req.body.Digits || '').toString().trim();

  if (!digits && userInput) {
    const coerced = coerceSpeechToDigit(userInput);
    if (coerced) digits = coerced;
  }

  // UNA SOLA instancia de VoiceResponse
  const vr = new twiml.VoiceResponse();

  const callSid: string = (req.body.CallSid || '').toString();
  const state = CALL_STATE.get(callSid) || {};

  // --- Selección de idioma por query (?lang=en|es) e intro por defecto en inglés ---
  const langParam = typeof req.query.lang === 'string' ? (req.query.lang as string) : undefined;

  // Si es la primera vez y no hay idioma aún, reproducir intro en inglés con opción a marcar 2 para español
  if (!langParam && !state.turn && !userInput && !digits) {
  // 👉 Lo que vamos a locutar en el intro
  const introEn = 'Hi, this is Amy from Synergy Zone. Para español, marque dos.';
  console.log('[VOICE][SAY]', JSON.stringify({
    callSid,
    to: didNumber,
    lang: 'en-US',
    speakOut: introEn,
    ctx: 'intro'
  }));
  return res.type('text/xml').send(introByLanguage());
}

const turn = (state.turn ?? 0) + 1;
CALL_STATE.set(callSid, { ...state, turn });
console.log('[VOICE][TURN]', JSON.stringify({ callSid, turn }));

  // Si viene ?lang=..., persiste en estado para el resto de la llamada
  if (langParam) {
    const chosen = langParam === 'es' ? 'es-ES' : 'en-US';
    CALL_STATE.set(callSid, { ...state, lang: chosen });
  }

  // ⬇️ LOG — lo que dijo el cliente
  logUserAsk({
    callSid,
    from: callerE164 || callerRaw,
    digits,
    userInput,
    lang: (state.lang as any) || (typeof req.query.lang === 'string' ? (req.query.lang === 'es' ? 'es-ES' : 'en-US') : undefined),
    // rawBody: req.body, // <- útil para debug profundo, comenta si es muy ruidoso
  });

  try {
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

    const currentLocale = (state.lang as any) || (langParam === 'es' ? 'es-ES' : 'en-US');

    const voiceName: any = 'alice';

    // ——— Menú inicial si aún no hay input ni confirmaciones pendientes ———
    if (!userInput && !digits && !state.awaiting && !state.awaitingNumber) {
      const brandForMenu = await getTenantBrand(tenant.id);
      playMainMenu(vr, currentLocale as any, voiceName, brandForMenu, callSid, didNumber);
      return res.type('text/xml').send(vr.toString());
    }

    // ✅ handler de silencio (cuando Twilio devuelve sin SpeechResult/Digits en turnos posteriores)
    if (!userInput && !digits && Object.prototype.hasOwnProperty.call(req.body, 'SpeechResult')) {
      // Si estamos esperando confirmación del SMS, re-pregunta esa confirmación (y escucha)
      if (state.awaiting && state.pendingType) {
        const vrAsk = new twiml.VoiceResponse();
        offerSms(
          vrAsk,
          currentLocale as any,
          voiceName,
          callSid,
          state,
          state.pendingType
        );
        STATE_TIME.set(callSid, Date.now());
        return res.type('text/xml').send(vrAsk.toString());
      }

      // Si NO estamos esperando confirmación → vuelve al menú
      const vrSilence = new twiml.VoiceResponse();
      const brandForMenu = await getTenantBrand(tenant.id);
      playMainMenu(vrSilence, currentLocale as any, voiceName, brandForMenu, callSid, didNumber);
      STATE_TIME.set(callSid, Date.now());
      return res.type('text/xml').send(vrSilence.toString());
    }

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
          vr.say({ language: currentLocale as any, voice: voiceName },
                'No se pudo completar la transferencia. Te envié el WhatsApp por SMS. ¿Algo más?');
        } catch (e) {
          console.error('[TRANSFER SMS FALLBACK] Error:', e);
          vr.say({ language: currentLocale as any, voice: voiceName },
                'No se pudo completar la transferencia. Si quieres, te envío el WhatsApp por SMS. Di "sí" o pulsa 1.');
          CALL_STATE.set(callSid, { ...state, awaiting: true, pendingType: 'soporte' });
        }

        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
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

    // ✅ capturar número cuando estábamos esperando uno
    if (state.awaitingNumber && (userInput || digits)) {
      const rawDigits = digits || extractDigits(userInput);
      let candidate = rawDigits ? `+${rawDigits.replace(/^\+/, '')}` : null;

      try {
        if (candidate) candidate = normalizarNumero(candidate);
      } catch {}

      if (!candidate || !isValidE164(candidate)) {
        const askAgain = currentLocale.startsWith('es')
          ? 'No pude tomar ese número. Dímelo con código de país o márcalo ahora.'
          : 'I couldn’t catch that number. Please include the country code or key it in now.';
        const vrNum = new twiml.VoiceResponse();
        vrNum.say({ language: currentLocale as any, voice: 'alice' }, askAgain);
        vrNum.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 15,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });
        STATE_TIME.set(callSid, Date.now());
        return res.type('text/xml').send(vrNum.toString());
      }

      // guardamos destino y dejamos de esperar número
      const nextState = { ...state, altDest: candidate, awaitingNumber: false };
      CALL_STATE.set(callSid, nextState);
      STATE_TIME.set(callSid, Date.now());

      // si había tipo pendiente, enviamos ya
      const tipo = nextState.pendingType || 'web';
      try {
        await enviarSmsConLink(tipo, {
          tenantId: tenant.id,
          callerE164,
          callerRaw,
          smsFromCandidate: tenant.twilio_sms_number || tenant.twilio_voice_number || '',
          callSid,
          overrideDestE164: candidate,
        });
        const ok = currentLocale.startsWith('es')
          ? 'Listo, te envié el enlace por SMS. ¿Algo más?'
          : 'Done, I just texted you the link. Anything else?';

        const vrOk = new twiml.VoiceResponse();
        vrOk.say({ language: currentLocale as any, voice: 'alice' }, ok);
        vrOk.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });
        return res.type('text/xml').send(vrOk.toString());
      } catch (e) {
        const bad = currentLocale.startsWith('es')
          ? 'No pude enviar el SMS ahora mismo.'
          : 'I couldn’t send the text right now.';
        const vrBad = new twiml.VoiceResponse();
        vrBad.say({ language: currentLocale as any, voice: 'alice' }, bad);
        return res.type('text/xml').send(vrBad.toString());
      }
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
      const ok = currentLocale.startsWith('es')
        ? 'Listo, te envié el enlace por SMS. ¿Algo más?'
        : 'Done, I just texted you the link. Anything else?';

      vr.say({ language: currentLocale as any, voice: voiceName }, ok);
      vr.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
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

      // Número de representante E.164 si quieres transferir (o deja null)
      const REPRESENTANTE_NUMBER = cfg?.representante_number || null;

      switch (digits) {
        case '1': { // PRECIOS
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'precios', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          offerSms(vr, currentLocale as any, voiceName, callSid, state, 'comprar');

          return res.type('text/xml').send(vr.toString());
        }
        case '2': { // HORARIOS
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'horarios', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          offerSms(vr, currentLocale as any, voiceName, callSid, state, 'web');
          
          return res.type('text/xml').send(vr.toString());
        }
        case '3': { // UBICACIÓN
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'ubicacion', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          offerSms(vr, currentLocale as any, voiceName, callSid, state, 'web');
          
          return res.type('text/xml').send(vr.toString());
        }
        case '4': { // REPRESENTANTE
          if (REPRESENTANTE_NUMBER) {
            vr.say({ language: currentLocale as any, voice: voiceName }, 
              currentLocale.startsWith('es')
                ? 'Te comunico con un representante. Un momento, por favor.'
                : 'Connecting you to a representative. One moment, please.'
            );
            const dial = vr.dial({
              action: '/webhook/voice-response?transfer=1',
              method: 'POST',
              timeout: 20,
            });
            dial.number(REPRESENTANTE_NUMBER);
            return res.type('text/xml').send(vr.toString());
          } else {
            vr.say({ language: currentLocale as any, voice: voiceName }, 
              currentLocale.startsWith('es')
                ? 'Ahora mismo no puedo transferirte. Si quieres, te envío nuestro WhatsApp por SMS.'
                : 'I can’t transfer you right now. I can text you our WhatsApp if you want.'
            );
            offerSms(vr, currentLocale as any, voiceName, callSid, state, 'soporte');
          }
          
          return res.type('text/xml').send(vr.toString());
        }
        default: {
          vr.say({ language: currentLocale as any, voice: voiceName },
            currentLocale.startsWith('es') ? 'No reconocí esa opción.' : 'I didn’t recognize that option.'
          );
        }
      }
    }

    // ——— FAST INTENT: si el usuario pidió algo directo (sin DTMF), lee desde prompt y luego ofrece SMS ———
    if (userInput) {
      const brand = await getTenantBrand(tenant.id);
      const s = userInput.toLowerCase();

      const wantsPrices   = /(precio|precios|tarifa|tarifas|cost|price)/i.test(s);
      const wantsHours    = /(horario|horarios|abren|cierran|hours|open|close)/i.test(s);
      const wantsLocation = /(ubicaci[oó]n|direcci[oó]n|d[oó]nde|address|location|mapa|maps)/i.test(s);
      const wantsPayments = /(pago|pagar|checkout|buy|pay|payment)/i.test(s);

      const sayAndOffer = async (topic: 'precios'|'horarios'|'ubicacion'|'pagos', tipoLink: LinkType) => {
      const spokenRaw = await snippetFromPrompt({ topic, cfg, locale: currentLocale as any, brand });
      const spoken = normalizeClockText(twoSentencesMax(spokenRaw), currentLocale as any);
      vr.say({ language: currentLocale as any, voice: voiceName }, spoken);

      offerSms(vr, currentLocale as any, voiceName, callSid, state, tipoLink);

      return res.type('text/xml').send(vr.toString());
    };

      if (wantsPrices)   return await sayAndOffer('precios',   'comprar');
      if (wantsHours)    return await sayAndOffer('horarios',  'web');
      if (wantsLocation) return await sayAndOffer('ubicacion', 'web');
      if (wantsPayments) return await sayAndOffer('pagos',     'comprar');
    }

    // ——— OpenAI ———
    let respuesta = currentLocale.startsWith('es') ? 'Disculpa, no entendí eso.' : "Sorry, I didn’t catch that.";
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      const brand = await getTenantBrand(tenant.id);

      // ✅ timeout de 6s para evitar cuelgues
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0, // 👈 evita alucinaciones
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              `Eres Amy, asistente telefónica del negocio ${brand}. 
              REGLAS:
              - NO menciones precios ni montos al hablar, nunca inventes números.
              - Si el usuario pregunta por precios, horarios, ubicación o pagos, ofrece enviar un SMS con el enlace correspondiente (no los leas en voz).
              - Jamás leas URL en voz. 
              - Responde breve y natural.`
          },
          { role: 'user', content: userInput },
        ],
      }, { signal: controller.signal as any });
      clearTimeout(timer);

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;
      console.log('[VOICE][OPENAI_RAW]', JSON.stringify({ callSid, lang: currentLocale, respuestaRaw: respuesta }));

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
        const ask = currentLocale.startsWith('es')
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
          const askNum = currentLocale.startsWith('es')
            ? '¿A qué número te lo envío? Dímelo con el código de país o márcalo ahora.'
            : 'What number should I text? Please include country code or key it in now.';
          // marcar que esperamos número
          CALL_STATE.set(callSid, { ...state, awaitingNumber: true, pendingType: smsType });
          vr.say({ language: currentLocale as any, voice: voiceName }, askNum);
          vr.gather({
            input: ['speech','dtmf'] as any,
            numDigits: 15,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
            actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
          });
          return res.type('text/xml').send(vr.toString());
        }

        // tenemos un número, pedir confirmación rápida
        const confirm = currentLocale.startsWith('es')
          ? `Te lo envío al ${maskForVoice(preferred)}. Di "sí" o pulsa 1 para confirmar, o dicta otro número.`
          : `I'll text ${maskForVoice(preferred)}. Say "yes" or press 1 to confirm, or say another number.`;
        CALL_STATE.set(callSid, { ...state, awaiting: true, pendingType: smsType });
        vr.say({ language: currentLocale as any, voice: voiceName }, confirm);
        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 15,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
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
        const syns = LINK_SYNONYMS[smsType];
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

        if (!chosen?.url) {
          console.warn('[VOICE/SMS] No hay link para el tipo solicitado:', smsType);
          respuesta += currentLocale.startsWith('es')
            ? ' No encontré un enlace registrado para eso.'
            : ' I couldn’t find a saved link for that.';
        } else {
          const brand = await getTenantBrand(tenant.id);
          const body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;
          const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || '';

          // elegir destino final: altDest confirmado o callerE164
          const override = (state.altDest && isValidE164(state.altDest)) ? state.altDest : null;
          const toDest = override || callerE164;

          console.log('[VOICE/SMS] SENDING', { smsFrom, toDest, callerRaw, callSid, tenantId: tenant.id });

          if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
            console.warn('[VOICE/SMS] Número destino inválido para SMS:', callerRaw, '→', toDest);
            respuesta += currentLocale.startsWith('es')
              ? ' No pude validar tu número para enviarte el SMS.'
              : ' I could not validate your number to text you.';
          } else if (!smsFrom) {
            console.warn('[VOICE/SMS] No hay un número SMS-capable configurado.');
            respuesta += currentLocale.startsWith('es')
              ? ' No hay un número SMS configurado para enviar el enlace.'
              : ' There is no SMS-capable number configured to send the link.';
          } else if (smsFrom && smsFrom.startsWith('whatsapp:')) {
            console.warn('[VOICE/SMS] El número configurado es WhatsApp; no envía SMS.');
            respuesta += currentLocale.startsWith('es')
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
                CALL_STATE.set(callSid, { ...(CALL_STATE.get(callSid) || {}), awaiting: false, pendingType: null, smsSent: true });
                STATE_TIME.set(callSid, Date.now());
                pool.query(
                  `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                  VALUES ($1, 'system', $2, NOW(), 'voz', $3)`,
                  [tenant.id, 'SMS enviado con link único.', smsFrom || 'sms']
                ).catch(console.error);
              })
              .catch((e) => {
                console.error('[VOICE/SMS] sendSMS ERROR:', e?.code, e?.message || e);
              });

            respuesta += currentLocale.startsWith('es')
              ? ' Te lo acabo de enviar por SMS.'
              : ' I just texted it to you.';
          }
        }
      } catch (e: any) {
        console.error('[VOICE/SMS] Error enviando SMS:', e?.code, e?.message, e?.moreInfo || e);
        respuesta += currentLocale.startsWith('es')
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
    respuesta = normalizeClockText(respuesta, currentLocale as any);
    const speakOut = sanitizeForSay(respuesta);

    // ⬇️ LOG — lo que dirá el bot (lo que Twilio locuta)
    logBotSay({
      callSid,
      to: didNumber,
      text: speakOut,
      lang: currentLocale as any,
      context: 'final-say'
    });

    if (!fin) {
      const contGather = vr.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });
      contGather.say({ language: currentLocale as any, voice: voiceName }, speakOut);
      const tailHelp = currentLocale.startsWith('es')
        ? 'Dime: precios, horarios, ubicación; o marca 1, 2, 3 o 4.'
        : 'Say: prices, hours, location; or press 1, 2, 3 or 4.';
      contGather.say({ language: currentLocale as any, voice: voiceName }, tailHelp);

    } else {
      CALL_STATE.delete(callSid);
      STATE_TIME.delete(callSid);
      vr.say({ language: currentLocale as any, voice: voiceName },
            currentLocale.startsWith('es') ? 'Gracias por tu llamada. ¡Hasta luego!' : 'Thanks for calling. Goodbye!');
      vr.hangup();
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
  console.error('❌ Error en voice-response:', err);
  const vrErr = new twiml.VoiceResponse();
  const errLocale = ((state.lang as any) || 'es-ES') as any; // ⛔ no usar cfgLocale aquí
  const errText = errLocale.startsWith('es')
    ? 'Perdón, hubo un problema. ¿Quieres que te envíe la información por SMS? Di sí o pulsa 1.'
    : 'Sorry, there was a problem. Do you want me to text you the info? Say yes or press 1.';
  vrErr.say({ language: errLocale as any, voice: 'alice' }, errText);
  vrErr.gather({
    input: ['speech','dtmf'] as any,
    numDigits: 1,
    action: '/webhook/voice-response',
    method: 'POST',
    language: errLocale as any,
    speechTimeout: 'auto',
  });

  return res.type('text/xml').send(vrErr.toString());  // ✅ mantener la llamada viva
}
});

export default router;
