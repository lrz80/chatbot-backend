// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { cycleStartForNow } from '../../utils/billingCycle';
import { sendSMS, normalizarNumero } from '../../lib/senders/sms';
import { canUseChannel } from "../../lib/features";
import { createAppointmentFromVoice } from "../../lib/appointments/createAppointmentFromVoice";
import { getBookingFlow } from "../../lib/appointments/getBookingFlow";
import { resolveVoiceScheduleValidation } from "../../lib/appointments/resolveVoiceScheduleValidation";

import { getVoiceCallState } from "../../lib/voice/getVoiceCallState";
import { upsertVoiceCallState } from "../../lib/voice/upsertVoiceCallState";
import { deleteVoiceCallState } from "../../lib/voice/deleteVoiceCallState";
import { resolveVoiceIntentFromUtterance } from "../../lib/voice/resolveVoiceIntentFromUtterance";

const router = Router();
const CHANNEL_KEY = "voice";

function resolveVoice(locale: string, cfgVoice?: string) {
  if (cfgVoice && cfgVoice !== 'alice') return cfgVoice;

  // fallback limpio
  if (locale.startsWith('es')) return 'Polly.Mia';
  if (locale.startsWith('pt')) return 'Polly.Vitoria';
  return 'Polly.Joanna';
}

const GLOBAL_ID = process.env.GLOBAL_CHANNEL_TENANT_ID!;

async function generateVoiceReply({
  tenantName,
  userInput,
  step,
  locale,
  bookingData,
  cfg,
}: {
  tenantName: string;
  userInput: string;
  step: 'service' | 'datetime' | 'confirm' | 'fallback';
  locale: string;
  bookingData?: {
    service?: string;
    datetime?: string;
  };
  cfg: any; // 👈 importante (puedes tiparlo mejor luego)
}) {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const system = cfg.system_prompt;

  const stepInstruction = {
    service: locale.startsWith('es')
      ? `El cliente quiere una cita. Pregunta qué servicio desea de forma natural.`
      : `The client wants to book. Ask what service they want.`,

    datetime: locale.startsWith('es')
      ? `El cliente ya dijo el servicio. Pide día y hora de forma natural.`
      : `Ask for date and time.`,

    confirm: locale.startsWith('es')
      ? `Confirma la cita usando estos datos:
    Servicio: ${bookingData?.service || 'no especificado'}
    Fecha/hora: ${bookingData?.datetime || 'no especificada'}

    Debe sonar natural, corto y pedir confirmación.`
      : `Confirm appointment using:
    Service: ${bookingData?.service || 'not specified'}
    Date/time: ${bookingData?.datetime || 'not specified'}

    Keep it natural and ask for confirmation.`,

    fallback: locale.startsWith('es')
      ? `El cliente dijo que no al SMS. Continúa la conversación de forma natural preguntando cómo puedes ayudar.`
      : `Client declined SMS. Continue conversation naturally.`,
  };

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `
Cliente dijo: "${userInput}"
Paso actual: ${stepInstruction[step]}
`,
      },
    ],
  });

  return completion.choices[0].message.content?.trim() || '';
}

function buildAnswersBySlot(params: {
  flow: Awaited<ReturnType<typeof getBookingFlow>>;
  bookingData: Record<string, string>;
}) {
  const answersBySlot: Record<string, string> = {};

  for (const step of params.flow) {
    const rawSlot = step.validation_config?.slot;
    const slot = typeof rawSlot === "string" ? rawSlot.trim() : "";

    if (!slot || slot === "none") continue;

    const value = params.bookingData?.[step.step_key];
    if (!value) continue;

    answersBySlot[slot] = value;
  }

  return answersBySlot;
}

// ———————————————————————————
//  Helpers de formato de hora / idioma / sanitización
// ———————————————————————————
function verbalizeSpanishTime(hour24: number, minute: number) {
  const period =
    hour24 < 12 ? "de la mañana" :
    hour24 < 19 ? "de la tarde" :
    "de la noche";

  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  if (minute === 0) {
    return `${hour12} ${period}`;
  }

  return `${hour12} y ${minute} ${period}`;
}

function normalizeClockText(text: string, locale: string) {
  let s = text || '';
  const isUS = (locale || '').toLowerCase() === 'en-us';
  const isES = (locale || '').toLowerCase().startsWith('es');

  s = s
    .replace(/\bantes\s+del\s+meridiano\b/gi, 'am')
    .replace(/\bdespu[eé]s\s+del\s+meridiano\b/gi, 'pm')
    .replace(/\ba\.?\s*m\.?\b/gi, 'am')
    .replace(/\bp\.?\s*m\.?\b/gi, 'pm');

  if (isES) {
    s = s.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi, (_, h, mm, ap) => {
      let hour = Number(h) % 12;
      const minute = Number(mm);
      if (ap.toLowerCase() === 'pm') hour += 12;
      return verbalizeSpanishTime(hour, minute);
    });

    s = s.replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (_, h, ap) => {
      let hour = Number(h) % 12;
      if (ap.toLowerCase() === 'pm') hour += 12;
      return verbalizeSpanishTime(hour, 0);
    });

    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) => {
      return verbalizeSpanishTime(Number(hh), Number(mm));
    });

    return s.replace(/\s+/g, ' ').trim();
  }

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
  }

  return s.replace(/\s+/g, ' ').trim();
}

function expandUsStreetType(type: string, locale: string) {
  const key = (type || "").toLowerCase().replace(/\./g, "");

  const mapEs: Record<string, string> = {
    st: "Street",
    ave: "Avenue",
    blvd: "Boulevard",
    rd: "Road",
    dr: "Drive",
    ln: "Lane",
    ct: "Court",
    cir: "Circle",
    pl: "Place",
    pkwy: "Parkway",
    hwy: "Highway",
  };

  const mapEn: Record<string, string> = {
    st: "Street",
    ave: "Avenue",
    blvd: "Boulevard",
    rd: "Road",
    dr: "Drive",
    ln: "Lane",
    ct: "Court",
    cir: "Circle",
    pl: "Place",
    pkwy: "Parkway",
    hwy: "Highway",
  };

  const map = locale.toLowerCase().startsWith("es") ? mapEs : mapEn;
  return map[key] || type;
}

function digitsForSpeech(value: string) {
  return (value || "").split("").join(" ");
}

function normalizeAddressForSpeech(text: string, locale: string) {
  let s = text || "";
  const isES = locale.toLowerCase().startsWith("es");

  s = s.replace(
    /\b(\d{3,6})\s+([A-Za-zÀ-ÿ0-9'’.-]+(?:\s+[A-Za-zÀ-ÿ0-9'’.-]+)*)\s+(St|Ave|Blvd|Rd|Dr|Ln|Ct|Cir|Pl|Pkwy|Hwy)\b\.?/gi,
    (_, streetNumber, streetName, streetType) => {
      const spokenNumber = digitsForSpeech(String(streetNumber));
      const spokenType = expandUsStreetType(String(streetType), locale);
      return `${spokenNumber} ${streetName} ${spokenType}`;
    }
  );

  s = s.replace(/\bFL\b/g, isES ? "Florida" : "Florida");
  s = s.replace(/\b(\d{5})(-\d{4})?\b/g, (_, zip, extra) => {
    const all = `${zip}${extra || ""}`.replace(/-/g, "");
    return digitsForSpeech(all);
  });

  return s.replace(/\s+/g, " ").trim();
}

function normalizeSpeechOutput(text: string, locale: string) {
  let s = text || "";
  s = normalizeClockText(s, locale);
  s = normalizeAddressForSpeech(s, locale);
  return s;
}

// ===== Estado por llamada (en memoria) =====
type CallState = {
  awaiting?: boolean;
  pendingType?: 'reservar' | 'comprar' | 'soporte' | 'web' | null;
  awaitingNumber?: boolean;
  altDest?: string | null;
  smsSent?: boolean;
  lang?: 'es-ES' | 'en-US' | 'pt-BR';
  turn?: number;
  bookingStepIndex?: number;
  bookingData?: Record<string, string>;
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
  const prevState = await getVoiceCallState(callSid);

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: prevState?.lang ?? null,
    turn: prevState?.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: prevState?.awaiting_number ?? false,
    altDest: prevState?.alt_dest ?? null,
    smsSent: true,
    bookingStepIndex: prevState?.booking_step_index ?? null,
    bookingData: prevState?.booking_data ?? {},
  });

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
    VALUES ($1, 'system', $2, NOW(), $3, $4)`,
    [tenantId, 'SMS enviado con link único.', CHANNEL_KEY, smsFrom || 'sms']
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

  const sys = locale.startsWith('es')
    ? `
  Eres Amy, asistente del negocio ${brand}.
  Usa EXCLUSIVAMENTE la información en estas dos fuentes:
  1) SYSTEM_PROMPT DEL NEGOCIO:
  ${(cfg.system_prompt || '').toString().trim()}

  2) INFO_CLAVE DEL NEGOCIO:
  ${(cfg.info_clave || '').toString().trim()}

  REGLAS DE RESPUESTA:
  - Devuelve 1-2 frases MÁXIMO, aptas para locución telefónica.
  - NO incluyas URLs ni digas "te envío link" (eso se ofrece fuera).
  - NO inventes datos.
  - Para HORARIOS, formatea horas natural.
  - Para PRECIOS, sólo menciona montos si aparecen literalmente.
  - Mantén el tono breve, claro y natural.
  `.trim()
    : `
  You are Amy, the assistant for ${brand}.
  Use ONLY the information from these two sources:
  1) BUSINESS SYSTEM PROMPT:
  ${(cfg.system_prompt || '').toString().trim()}

  2) BUSINESS KEY INFO:
  ${(cfg.info_clave || '').toString().trim()}

  RESPONSE RULES:
  - Reply in 1-2 sentences MAX, suitable for phone speech.
  - Do NOT include URLs or say you will send a link here.
  - Do NOT invent information.
  - For HOURS, format time naturally.
  - For PRICES, mention amounts only if they appear literally.
  - Keep the tone brief, clear, and natural.
  `.trim();

  const user = locale.startsWith('es')
    ? `Responde ÚNICAMENTE en español. Dame un breve resumen de ${topic} (máx 2 frases), usando sólo lo provisto.`
    : `Respond ONLY in English. Do not answer in Spanish. Give me a short summary about ${topic} in 1-2 sentences max, using only the provided information.`;

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
async function offerSms(
  vr: twiml.VoiceResponse,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  voiceName: any,
  callSid: string,
  state: CallState,
  tipo: LinkType,
  tenantId: string
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

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: state.lang ?? locale,
    turn: state.turn ?? 0,
    awaiting: true,
    pendingType: tipo,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex: state.bookingStepIndex ?? null,
    bookingData: state.bookingData ?? {},
  });

  // 👉 log del prompt de confirmación SMS
  logBotSay({ callSid, to: 'ivr', text: ask, lang: locale, context: `offer-sms:${tipo}` });
}

function playMainMenu(
  vr: twiml.VoiceResponse,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  voiceName: any,
  brand: string,
  greetingText: string,
  callSid?: string,
  toNumber?: string
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

  const menuText = locale.startsWith('es')
    ? `Puedes decirme que quieres agendar una cita, o marcar 1 para precios, 2 para horarios o 3 para ubicación.`
    : `You can tell me you want to book an appointment, or press 1 for prices, 2 for hours, or 3 for location.`;

  const fallbackGreeting = locale.startsWith('es')
    ? `Hola, soy Amy de ${brand}.`
    : `Hi, I'm Amy from ${brand}.`;

  const safeGreeting = (greetingText || '').trim() || fallbackGreeting;

  const line = `${safeGreeting} ${menuText}`.trim();

  gather.say({ language: locale as any, voice: voiceName }, line);

  // 👉 Log exacto de lo que locutas en el menú
  logBotSay({ callSid: callSid || 'N/A', to: toNumber || 'ivr', text: line, lang: locale, context: 'menu' });
}

// --- Selección de idioma inicial ---
// Antes: function introByLanguage(selected?: string) {
function introByLanguage(
  selected: string | undefined,
  brand: string | undefined,
  voiceName: string
) {
  const vr = new twiml.VoiceResponse();

  const business = brand && brand.trim().length > 0 ? brand.trim() : undefined;

  // Si ya viene forzado a español (?lang=es)
  if (selected === 'es') {
    const lineEs = business
      ? `Hola, soy Amy del equipo de ${business}. Continuamos en español.`
      : 'Hola, soy Amy. Continuamos en español.';

    vr.say({ language: 'es-ES', voice: resolveVoice('es-ES') as any }, lineEs);
    vr.redirect('/webhook/voice-response?lang=es');
    return vr.toString();
  }

  // Intro en INGLÉS con nombre del negocio (si lo tenemos)
  const lineEn = business
    ? `Hi, this is Amy from ${business}.`
    : 'Hi, this is Amy.';

  vr.say({ language: 'en-US', voice: resolveVoice('en-US') as any }, lineEn);

  // Frase en ESPAÑOL para elegir idioma + gather
  const g = vr.gather({
    input: ['dtmf', 'speech'] as any,
    numDigits: 1,
    timeout: 6,
    language: 'es-ES' as any,
    speechTimeout: 'auto',
    enhanced: true,
    speechModel: 'phone_call',
    hints: 'español, espanol, dos, 2',
    action: '/webhook/voice-response/lang',
    method: 'POST',
    actionOnEmptyResult: true,
    bargeIn: true,
  });

  g.say(
    { language: 'es-ES', voice: resolveVoice('es-ES') as any },
    'Para español, marque dos o diga “Español”.'
  );

  vr.redirect('/webhook/voice-response/lang?fallback=en');

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

async function getLastAssistantVoiceMessage(params: {
  tenantId: string;
  didNumber: string;
}) {
  const { rows } = await pool.query(
    `
    SELECT content
    FROM messages
    WHERE tenant_id = $1
      AND canal = $2
      AND role = 'assistant'
      AND from_number = $3
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [params.tenantId, CHANNEL_KEY, params.didNumber || 'sistema']
  );

  return (rows?.[0]?.content || '').toString().trim();
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
  if (/\b(horario|horarios|hours|open|close|abren|cierran)\b/u.test(w)) return '2';
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

// Convierte números hablados a dígitos (ES/EN) para capturar teléfonos por voz
function wordsToDigits(s: string) {
  if (!s) return '';
  const txt = s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
    .replace(/[^\p{L}\p{N}\s\+]/gu, ' ')             // limpia símbolos raros
    .replace(/\s+/g, ' ')
    .trim();

  const map: Record<string, string> = {
    // ESP
    'cero':'0','uno':'1','una':'1','dos':'2','tres':'3','cuatro':'4','cinco':'5','seis':'6','siete':'7','ocho':'8','nueve':'9',
    'diez':'10', // por si lo dicen en pareja; intentaremos dividir luego
    // ENG
    'zero':'0','oh':'0','o':'0', // "oh" / "o" a veces para 0
    'one':'1','won':'1', 'juan':'1','two':'2','too':'2','to':'2','three':'3','tri':'3', 'tree':'3', 'free':'3','four':'4','for':'4','fore':'4','five':'5','six':'6','seven':'7','eight':'8','ate':'8','eit':'8','nine':'9','nain':'9',
    // Ruido común
    'plus':'+','mas':'+','más':'+','signo':'','signo+':'','guion':'','guión':'','dash':'','space':'','y':'','and':'',
    // “relleno” que conviene ignorar cuando dictan: “mi número es…”
    'mi':'','numero':'','número':'','es':'','my':'','number':'','is':'','codigo':'','código':'','area':'','code':'',
    'con':'','de':'','a':'','al':'','please':'','por':'','favor':'','please,':'',
  };

  const out: string[] = [];
  for (const token of txt.split(' ')) {
    if (/^\+?\d+$/.test(token)) { out.push(token); continue; } // ya venía como 305 o +1
    const m = map[token];
    if (m != null) out.push(m);
  }

  let joined = out.join('');
  // Normaliza múltiplos '+' y deja solo el inicial
  if ((joined.match(/\+/g) || []).length > 1) {
    joined = '+' + joined.replace(/\+/g, '');
  }
  // Si quedó "10" proveniente de "diez", parte en "1" "0" (teléfonos se dictan dígito a dígito)
  joined = joined.replace(/10/g, '10'); // (nada que hacer si realmente dijeron "diez"; se usa tal cual)
  // Quita caracteres que no sean + o dígito:
  joined = joined.replace(/[^\d+]/g, '');

  // Si NO empieza con '+' y parece número válido de 10–15, prepende '+' (lo haces igual en tu flujo)
  if (!joined.startsWith('+') && /^\d{10,15}$/.test(joined)) {
    joined = '+' + joined;
  }

  return joined;
}

function renderBookingTemplate(
  template: string,
  bookingData: Record<string, string>
) {
  let output = template || "";

  for (const [key, value] of Object.entries(bookingData || {})) {
    output = output.split(`{${key}}`).join(value || "");
  }

  return output.trim();
}

function buildBookingPromptVariables(params: {
  bookingData: Record<string, string>;
  callerE164: string | null;
}) {
  return {
    ...params.bookingData,
    current_phone: params.callerE164 || "",
    current_phone_masked: params.callerE164 ? maskForVoice(params.callerE164) : "",
  };
}

function resolveBookingSuccessStep(params: {
  flow: Awaited<ReturnType<typeof getBookingFlow>>;
}) {
  return params.flow.find((step) => {
    if (!step.enabled) return false;
    if (step.expected_type !== "text") return false;
    if (step.required) return false;

    const slot =
      typeof step.validation_config?.slot === "string"
        ? step.validation_config.slot.trim()
        : "";

    return slot === "none";
  });
}

function normalizeVoiceServiceText(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type VoiceBookingServiceOption = {
  value: string;
  aliases: string[];
};

type VoiceBookingServiceResolution =
  | { kind: "resolved_single"; value: string }
  | { kind: "ambiguous"; options: string[] }
  | { kind: "none" };

function parseVoiceBookingServices(raw: string): VoiceBookingServiceOption[] {
  return (raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [canonicalPart, aliasesPart = ""] = line.split("|");
      const value = (canonicalPart || "").trim();

      const aliases = aliasesPart
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);

      if (!value) return null;

      return {
        value,
        aliases,
      };
    })
    .filter((item): item is VoiceBookingServiceOption => Boolean(item));
}

function scoreVoiceBookingCandidate(userInput: string, candidate: string): number {
  const normalizedInput = normalizeVoiceServiceText(userInput);
  const normalizedCandidate = normalizeVoiceServiceText(candidate);

  if (!normalizedInput || !normalizedCandidate) return 0;

  if (normalizedInput === normalizedCandidate) {
    return 100;
  }

  if (
    normalizedInput.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedInput)
  ) {
    return 85;
  }

  const inputTokens = new Set(normalizedInput.split(" ").filter(Boolean));
  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);

  if (!candidateTokens.length) return 0;

  const overlap = candidateTokens.filter((token) => inputTokens.has(token)).length;
  const coverage = overlap / candidateTokens.length;

  if (coverage >= 0.8) return 75;
  if (coverage >= 0.6) return 60;
  if (coverage >= 0.4) return 40;

  return 0;
}

function resolveVoiceBookingService(params: {
  userInput: string;
  rawConfig: string;
}): VoiceBookingServiceResolution {
  const normalizedInput = normalizeVoiceServiceText(params.userInput);
  const options = parseVoiceBookingServices(params.rawConfig);

  if (!normalizedInput || !options.length) {
    return { kind: "none" };
  }

  const ranked = options
    .map((option) => {
      const candidates = [option.value, ...option.aliases];
      const bestScore = Math.max(
        ...candidates.map((candidate) =>
          scoreVoiceBookingCandidate(params.userInput, candidate)
        )
      );

      return {
        value: option.value,
        score: bestScore,
      };
    })
    .filter((item) => item.score >= 60)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { kind: "none" };
  }

  const top = ranked[0];
  const second = ranked[1];

  if (top.score >= 85 && (!second || top.score - second.score >= 15)) {
    return {
      kind: "resolved_single",
      value: top.value,
    };
  }

  const ambiguousOptions = ranked.slice(0, 4).map((item) => item.value);

  if (ambiguousOptions.length === 1) {
    return {
      kind: "resolved_single",
      value: ambiguousOptions[0],
    };
  }

  return {
    kind: "ambiguous",
    options: ambiguousOptions,
  };
}

router.post('/lang', async (req: Request, res: Response) => {
  const rawDigits = (req.body.Digits || '').toString().trim();

  // ⬇️ normaliza: minúsculas + sin tildes/diacríticos
  const speechRaw = (req.body.SpeechResult || '').toString().trim();
  const speech = speechRaw
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos: español -> espanol
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')                // limpia signos
    .replace(/\s+/g, ' ')
    .trim();

  console.log('[VOICE][LANG]', JSON.stringify({
    digits: rawDigits,
    speech,
    bodyKeys: Object.keys(req.body || {})
  }));

  let chosen: 'en' | 'es' = 'en';
  if (rawDigits === '2') {
    chosen = 'es';
  } else if (/(spanish|espanol|español|castellano|\b2\b|dos)/i.test(speech)) {
    chosen = 'es';
  }

  const vr = new twiml.VoiceResponse();
  if (chosen === 'es') {
    vr.say({ language: 'es-ES', voice: resolveVoice('es-ES') as any }, 'Has seleccionado español.');
    vr.redirect('/webhook/voice-response?lang=es');
  } else {
    vr.say({ language: 'en-US', voice: resolveVoice('en-US') as any }, 'Continuing in English.');
    vr.redirect('/webhook/voice-response?lang=en');
  }

  return res.type('text/xml').send(vr.toString());
});

type PhoneResolutionResult =
  | { ok: true; value: string }
  | { ok: false };

function resolvePhoneFromVoiceInput(params: {
  userInput: string;
  digits: string;
  callerE164: string | null;
  step: any;
}): PhoneResolutionResult {
  const raw = (params.userInput || params.digits || "").trim();
  const config = params.step?.validation_config || {};
  const mode = typeof config.mode === "string" ? config.mode : "free_input";
  const useInboundCaller = !!config.use_inbound_caller;

  const spoken = wordsToDigits(raw || "");
  const digitsOnly = extractDigits(spoken || raw || "");

  if (digitsOnly) {
    const normalized = normalizarNumero(`+${digitsOnly}`);
    if (isValidE164(normalized)) {
      return { ok: true, value: normalized };
    }
  }

  // ✅ Si el flujo permite usar el número entrante y ya tenemos uno válido,
  // úsalo automáticamente como valor del slot.
  if (
    useInboundCaller &&
    params.callerE164 &&
    isValidE164(params.callerE164) &&
    (mode === "confirm_or_replace" || mode === "inbound_caller")
  ) {
    return { ok: true, value: params.callerE164 };
  }

  // ✅ Mantén compatibilidad con confirmación explícita por voz/dtmf
  if (
    mode === "confirm_or_replace" &&
    useInboundCaller &&
    params.callerE164 &&
    isValidE164(params.callerE164) &&
    (saidYes(raw) || params.digits === "1")
  ) {
    return { ok: true, value: params.callerE164 };
  }

  return { ok: false };
}

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

  const resolvedInitialVoiceIntent = userInput
    ? resolveVoiceIntentFromUtterance(userInput)
    : null;

  if (!digits && userInput && resolvedInitialVoiceIntent !== "booking") {
    const coerced = coerceSpeechToDigit(userInput);
    if (coerced) digits = coerced;
  }

  // UNA SOLA instancia de VoiceResponse
  const vr = new twiml.VoiceResponse();

  const callSid: string = (req.body.CallSid || '').toString();
  const persistedState = await getVoiceCallState(callSid);

  let state: CallState = persistedState
    ? {
        awaiting: persistedState.awaiting,
        pendingType: persistedState.pending_type,
        awaitingNumber: persistedState.awaiting_number,
        altDest: persistedState.alt_dest,
        smsSent: persistedState.sms_sent,
        lang: (persistedState.lang as CallState["lang"]) || undefined,
        turn: persistedState.turn,
        bookingStepIndex:
          typeof persistedState.booking_step_index === "number"
            ? persistedState.booking_step_index
            : undefined,
        bookingData: persistedState.booking_data || {},
      }
    : {};

  const langParam = typeof req.query.lang === 'string' ? (req.query.lang as string) : undefined;

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
    if (!tenant) {
      console.error("[VOICE] tenant no encontrado para twilio_voice_number:", didNumber);
      return res.status(404).type("text/plain").send("tenant_not_found");
    }

    if (langParam) {
      const chosen = langParam === 'es' ? 'es-ES' : 'en-US';

      state = {
        ...state,
        lang: chosen,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: chosen,
        turn: state.turn ?? 0,
        awaiting: state.awaiting ?? false,
        pendingType: state.pendingType ?? null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    // Nombre de marca del tenant (para hablar en la intro)
    const brand = await getTenantBrand(tenant.id);

    // ✅ Gate VOZ por plan + toggles + pausa (igual que el front)
    try {
      const gate = await canUseChannel(tenant.id, "voice");

      if (!gate.enabled) {
        // Limpia estado de la llamada
        await deleteVoiceCallState(callSid);

        const bye = new twiml.VoiceResponse();
        const lang =
          ((state.lang as any) ||
            (typeof req.query.lang === 'string' && req.query.lang === 'es'
              ? 'es-ES'
              : 'en-US')) as any;

        // ✅ Mensaje 100% neutro para el cliente (no menciona plan ni membresía)
        const msg = lang.startsWith('es')
          ? 'En este momento no hay asistente de voz disponible en este número. Gracias por llamar.'
          : 'The voice assistant for this number is not available at the moment. Thank you for calling.';

        console.log("🛑 VOZ bloqueado por plan/toggle/pausa", {
          tenantId: tenant.id,
          plan_enabled: gate.plan_enabled,
          settings_enabled: gate.settings_enabled,
          paused_until: gate.paused_until,
          reason: gate.reason,
        });

        bye.say({ language: lang, voice: resolveVoice(lang) as any }, msg);
        bye.hangup();
        return res.type("text/xml").send(bye.toString());
      }
    } catch (e) {
      console.warn("Guard VOZ: error en canUseChannel('voice'); bloquea por seguridad:", e);
      await deleteVoiceCallState(callSid);
      const bye = new twiml.VoiceResponse();
      bye.say({ language: "es-ES", voice: resolveVoice("es-ES") as any }, "Lo sentimos, no podemos atender esta llamada ahora.");
      bye.hangup();
      return res.type("text/xml").send(bye.toString());
    }

    if (!tenant.membresia_activa) {
      // idioma según lo que ya eligió la persona (o inglés por defecto)
      const lang =
        ((state.lang as any) ||
          (typeof req.query.lang === 'string' && req.query.lang === 'es'
            ? 'es-ES'
            : 'en-US')) as any;

      const text = lang.startsWith('es')
        ? 'En este momento no hay asistente disponible en este número. Gracias por llamar.'
        : 'The assistant for this number is not available at the moment. Thank you for calling.';

      vr.say({ voice: resolveVoice(lang) as any, language: lang }, text);
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const currentLocale = (state.lang as any) || (langParam === 'es' ? 'es-ES' : 'en-US');

    let cfgRes = await pool.query(
      `SELECT *
        FROM voice_configs
        WHERE tenant_id = $1
          AND canal = $2
          AND idioma = $3
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [tenant.id, CHANNEL_KEY, currentLocale]
    );

    let cfg = cfgRes.rows[0];

    if (!cfg) {
      cfgRes = await pool.query(
        `SELECT *
          FROM voice_configs
          WHERE tenant_id = $1
            AND canal = $2
          ORDER BY
            CASE
              WHEN idioma = 'en-US' THEN 0
              WHEN idioma = 'es-ES' THEN 1
              WHEN idioma = 'pt-BR' THEN 2
              ELSE 3
            END,
            updated_at DESC,
            created_at DESC
          LIMIT 1`,
        [tenant.id, CHANNEL_KEY]
      );

      cfg = cfgRes.rows[0];
    }

    if (!cfg) {
      console.error("[VOICE] voice_config no encontrada para tenant:", tenant.id, "locale:", currentLocale);
      return res.status(404).type("text/plain").send("voice_config_not_found");
    }

    const voiceName: any = resolveVoice(currentLocale, cfg?.voice_name);

    // 👉 Primer hit de la llamada: intro en inglés + “para español oprima 2” con nombre del negocio
    if (!state.turn && !langParam && !userInput && !digits) {
      const introXml = introByLanguage(undefined, brand, voiceName);
      return res.type('text/xml').send(introXml);
    }

    // A partir de aquí ya contamos los turnos de la llamada
    const turn = (state.turn ?? 0) + 1;
    state = { ...state, turn };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn,
      awaiting: state.awaiting ?? false,
      pendingType: state.pendingType ?? null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });

    console.log('[VOICE][TURN]', JSON.stringify({ callSid, turn }));

    // ——— Menú inicial si aún no hay input ni confirmaciones pendientes ———
    if (
      !userInput &&
      !digits &&
      !state.awaiting &&
      !state.awaitingNumber &&
      typeof state.bookingStepIndex !== "number"
    ) {
      const brandForMenu = await getTenantBrand(tenant.id);

      const fallbackWelcome = currentLocale.startsWith('es')
        ? `Hola, soy Amy del equipo de ${brandForMenu}. ¿En qué puedo ayudarte hoy?`
        : `Hi, this is Amy from ${brandForMenu}. How can I help you today?`;

      const welcomeText = twoSentencesMax(
        (cfg?.welcome_message || '').trim() || fallbackWelcome
      );

      const gather = vr.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        welcomeText
      );

      logBotSay({
        callSid,
        to: didNumber || 'ivr',
        text: welcomeText,
        lang: currentLocale,
        context: 'welcome',
      });

      return res.type('text/xml').send(vr.toString());
    }

    // ✅ handler de silencio (cuando Twilio devuelve sin SpeechResult/Digits en turnos posteriores)
    const noUserTurnInput =
      !userInput &&
      !digits &&
      !String(req.body.SpeechResult || "").trim() &&
      !String(req.body.Digits || "").trim();

    if (noUserTurnInput) {
      // Si estamos esperando confirmación del SMS, re-pregunta esa confirmación
      if (state.awaiting && state.pendingType) {
        const vrAsk = new twiml.VoiceResponse();
        await offerSms(
          vrAsk,
          currentLocale as any,
          voiceName,
          callSid,
          state,
          state.pendingType,
          tenant.id
        );

        return res.type('text/xml').send(vrAsk.toString());
      }

      // Si estamos dentro de un booking, NO vuelvas a la bienvenida.
      // Repite el step actual del booking.
      if (typeof state.bookingStepIndex === "number") {
        const flow = await getBookingFlow(tenant.id);
        const currentStep = flow[state.bookingStepIndex];

        if (currentStep) {
          const vrBookingSilence = new twiml.VoiceResponse();

          const prompt = renderBookingTemplate(
            currentStep.retry_prompt || currentStep.prompt,
            buildBookingPromptVariables({
              bookingData: state.bookingData || {},
              callerE164,
            })
          );

          const isPhoneStep = currentStep.expected_type === "phone";
          const isConfirmationStep = currentStep.expected_type === "confirmation";

          const gather = vrBookingSilence.gather({
            input: isPhoneStep || isConfirmationStep ? ['speech', 'dtmf'] as any : ['speech'] as any,
            numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,
            actionOnEmptyResult: true,
            bargeIn: true,
          });

          gather.say(
            { language: currentLocale as any, voice: voiceName },
            twoSentencesMax(prompt)
          );

          logBotSay({
            callSid,
            to: didNumber || 'ivr',
            text: twoSentencesMax(prompt),
            lang: currentLocale,
            context: `booking_retry:${currentStep.step_key}`,
          });

          return res.type('text/xml').send(vrBookingSilence.toString());
        }
      }

      // Si no hay booking activo, mantén el contexto repitiendo el último mensaje real del bot
      const vrSilence = new twiml.VoiceResponse();

      const lastAssistantMessage = await getLastAssistantVoiceMessage({
        tenantId: tenant.id,
        didNumber: didNumber || 'sistema',
      });

      const retryText = twoSentencesMax(
        sanitizeForSay(
          lastAssistantMessage || (cfg?.welcome_message || '').trim()
        )
      );

      const gather = vrSilence.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      if (retryText) {
        gather.say(
          { language: currentLocale as any, voice: voiceName },
          retryText
        );

        logBotSay({
          callSid,
          to: didNumber || 'ivr',
          text: retryText,
          lang: currentLocale,
          context: 'silence_retry_last_assistant',
        });
      }

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
            smsFromCandidate: tenant.twilio_sms_number || '',
            callSid,
          });
          vr.say({ language: currentLocale as any, voice: voiceName },
                'No se pudo completar la transferencia. Te envié el WhatsApp por SMS. ¿Algo más?');
        } catch (e) {
          console.error('[TRANSFER SMS FALLBACK] Error:', e);
          vr.say({ language: currentLocale as any, voice: voiceName },
                'No se pudo completar la transferencia. Si quieres, te envío el WhatsApp por SMS. Di "sí" o pulsa 1.');
          await upsertVoiceCallState({
            callSid,
            tenantId: tenant.id,
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: true,
            pendingType: 'soporte',
            awaitingNumber: state.awaitingNumber ?? false,
            altDest: state.altDest ?? null,
            smsSent: state.smsSent ?? false,
            bookingStepIndex: state.bookingStepIndex ?? null,
            bookingData: state.bookingData ?? {},
          });
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

    console.log('[VOICE][NUM_CAPTURE]', JSON.stringify({
      callSid,
      SpeechResult: req.body.SpeechResult,
      Digits: req.body.Digits
    }));

    // ✅ capturar número cuando estábamos esperando uno
    if (state.awaitingNumber && (userInput || digits)) {
      let rawDigits = digits || extractDigits(userInput);
      if (!rawDigits) {
        const spoken = wordsToDigits(userInput);
        rawDigits = extractDigits(spoken) || ''; // vuelve a limpiar por si vino con '+'
      }
      let candidate = rawDigits ? `+${rawDigits.replace(/^\+/, '')}` : null;

      try {
        if (candidate) candidate = normalizarNumero(candidate);
      } catch {}

      if (!candidate || !isValidE164(candidate)) {
        const askAgain = currentLocale.startsWith('es')
          ? 'No pude tomar ese número. Dímelo con código de país o márcalo ahora.'
          : 'I couldn’t catch that number. Please include the country code or key it in now.';
        const vrNum = new twiml.VoiceResponse();
        vrNum.say({ language: currentLocale as any, voice: voiceName }, askAgain);
        vrNum.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 15,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 10,               // un poco más de tiempo
        actionOnEmptyResult: true,
        bargeIn: true,
        enhanced: true,            // mejora el ASR
        speechModel: 'phone_call', // modelo recomendado para llamadas
        hints: currentLocale.startsWith('es')
          ? 'más, mas, signo, uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, cero, guion, espacio'
          : 'plus, one, two, three, four, five, six, seven, eight, nine, zero, dash, space'
      });
        return res.type('text/xml').send(vrNum.toString());
      }

      // guardamos destino y dejamos de esperar número
      const nextState = { ...state, altDest: candidate, awaitingNumber: false };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: nextState.awaiting ?? false,
        pendingType: nextState.pendingType ?? null,
        awaitingNumber: false,
        altDest: candidate,
        smsSent: nextState.smsSent ?? false,
        bookingStepIndex: nextState.bookingStepIndex ?? null,
        bookingData: nextState.bookingData ?? {},
      });

      // si había tipo pendiente, enviamos ya
      const tipo = nextState.pendingType || 'web';
      try {
        await enviarSmsConLink(tipo, {
          tenantId: tenant.id,
          callerE164,
          callerRaw,
          smsFromCandidate: tenant.twilio_sms_number || '',
          callSid,
          overrideDestE164: candidate,
        });
        const ok = currentLocale.startsWith('es')
          ? 'Listo, te envié el enlace por SMS. ¿Algo más?'
          : 'Done, I just texted you the link. Anything else?';

        const vrOk = new twiml.VoiceResponse();
        vrOk.say({ language: currentLocale as any, voice: voiceName }, ok);
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
        vrBad.say({ language: currentLocale as any, voice: voiceName }, bad);
        return res.type('text/xml').send(vrBad.toString());
      }
    }

    // ✅ FAST-PATH: confirmación de SMS sin pasar por OpenAI
    let earlySmsType: LinkType | null = null;

    // Si estábamos esperando confirmación de SMS, pero el usuario hizo una nueva pregunta,
    // cancelamos el SMS pendiente y seguimos procesando esa intención en el mismo turno.
    if (state.awaiting && userInput && !saidYes(userInput) && !saidNo(userInput)) {
      const nextDigit = coerceSpeechToDigit(userInput);

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });

      if (nextDigit) {
        digits = nextDigit;
      }
    }

    // Caso A: venías esperando confirmación por estado y dijo “sí/1”
    if (state.awaiting && (saidYes(userInput) || digits === '1')) {
      earlySmsType = (state.pendingType || guessType(userInput)) as LinkType;

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    if (state.awaiting && (saidNo(userInput) || digits === '2')) {
      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });

      // 👉 RESPUESTA CON LLM (no hardcode)
      const replyRaw = await generateVoiceReply({
        tenantName: brand,
        userInput,
        step: 'fallback',
        locale: currentLocale,
        cfg,
      });

      const reply = twoSentencesMax(replyRaw);

      const gather = vr.gather({
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

      gather.say({ language: currentLocale as any, voice: voiceName }, reply);

      return res.type('text/xml').send(vr.toString());
    }

    // Caso B: último turno marcó <SMS_PENDING:...> y ahora dijo “sí/1”
    if (!earlySmsType) {
      const { rows: lastAssistantRows } = await pool.query(
        `SELECT content
          FROM messages
          WHERE tenant_id = $1
            AND canal = $2
            AND role = 'assistant'
            AND from_number = $3
          ORDER BY timestamp DESC
          LIMIT 1`,
        [tenant?.id, CHANNEL_KEY, didNumber || 'sistema']
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
        smsFromCandidate: tenant.twilio_sms_number || '',
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
        VALUES ($1, 'user', $2, NOW(), $3, $4)`,
        [tenant.id, userInput, CHANNEL_KEY, callerE164 || 'anónimo']
      );

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
        VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
        [tenant.id, ok, CHANNEL_KEY, didNumber || 'sistema']
      );

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, created_at)
        VALUES ($1, $2, NOW())`,
        [tenant.id, CHANNEL_KEY]
      );

      await incrementarUsoPorNumero(didNumber);
      return res.type('text/xml').send(vr.toString());
    }

    // ===== IVR simple por dígito (1/2/3/4) =====
    const resolvedVoiceIntentForTurn = userInput
      ? resolveVoiceIntentFromUtterance(userInput)
      : null;

    if (
      digits &&
      !state.awaiting &&
      typeof state.bookingStepIndex !== "number" &&
      resolvedVoiceIntentForTurn !== "booking"
    ) {
      // Número de representante E.164 si quieres transferir (o deja null)
      const REPRESENTANTE_NUMBER = cfg?.representante_number || null;

      switch (digits) {
        case '1': { // PRECIOS
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'precios', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          await offerSms(vr, currentLocale as any, voiceName, callSid, state, 'comprar', tenant.id);

          return res.type('text/xml').send(vr.toString());
        }
        case '2': { // HORARIOS
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'horarios', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          await offerSms(vr, currentLocale as any, voiceName, callSid, state, 'web', tenant.id);
          
          return res.type('text/xml').send(vr.toString());
        }
        case '3': { // UBICACIÓN
          const brand = await getTenantBrand(tenant.id);
          const spoken = await snippetFromPrompt({ topic: 'ubicacion', cfg, locale: currentLocale as any, brand });
          vr.say({ language: currentLocale as any, voice: voiceName }, spoken);
          await offerSms(vr, currentLocale as any, voiceName, callSid, state, 'web', tenant.id);
          
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
                ? 'Ahora mismo no puedo transferirte.'
                : 'I can’t transfer you right now.'
            );
            await offerSms(vr, currentLocale as any, voiceName, callSid, state, 'soporte', tenant.id);
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
      const resolvedVoiceIntent = resolveVoiceIntentFromUtterance(userInput);
      const wantsBooking = resolvedVoiceIntent === "booking";

      if (wantsBooking && typeof state.bookingStepIndex !== "number") {
        const flow = await getBookingFlow(tenant.id);

        console.log("[VOICE][BOOKING_FLOW_LOADED]", {
          callSid,
          tenantId: tenant.id,
          steps: flow.map((s) => ({
            key: s.step_key,
            order: s.step_order,
            type: s.expected_type,
            enabled: s.enabled,
            slot:
              typeof s.validation_config?.slot === "string"
                ? s.validation_config.slot
                : null,
            validation_config: s.validation_config || null,
          })),
        });

        if (!flow.length) {
          throw new Error("BOOKING_FLOW_NOT_CONFIGURED");
        }

        const firstStep = flow[0];

        state = {
          ...state,
          bookingStepIndex: 0,
          bookingData: {},
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: state.awaiting ?? false,
          pendingType: state.pendingType ?? null,
          awaitingNumber: state.awaitingNumber ?? false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: 0,
          bookingData: {},
        });

        const ask = twoSentencesMax(firstStep.prompt);

        const gather = vr.gather({
          input: ['speech'] as any,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
        });

        gather.say({ language: currentLocale as any, voice: voiceName }, ask);

        return res.type('text/xml').send(vr.toString());
      }

      if (typeof state.bookingStepIndex === "number") {
        const flow = await getBookingFlow(tenant.id);
        const currentIndex = state.bookingStepIndex;
        const currentStep = flow[currentIndex];

        if (!currentStep) {
          await deleteVoiceCallState(callSid);
          throw new Error("BOOKING_STEP_NOT_FOUND");
        }

        if (currentStep.expected_type === "confirmation") {
          if (saidYes(userInput) || digits === "1") {
            try {
              const { rows: settingsRows } = await pool.query(
                `
                SELECT
                  default_duration_min,
                  buffer_min,
                  min_lead_minutes,
                  timezone,
                  enabled
                FROM appointment_settings
                WHERE tenant_id = $1
                LIMIT 1
                `,
                [tenant.id]
              );

              const appointmentSettings = settingsRows[0] || {
                default_duration_min: 30,
                buffer_min: 10,
                min_lead_minutes: 60,
                timezone: "America/New_York",
                enabled: true,
              };

              const answersBySlot = buildAnswersBySlot({
                flow,
                bookingData: state.bookingData || {},
              });

              console.log("[VOICE][BOOKING_DATA_RESOLVED]", {
                callSid,
                bookingData: state.bookingData || {},
                answersBySlot,
              });

              const appointment = await createAppointmentFromVoice({
                tenantId: tenant.id,
                answersBySlot,
                idempotencyKey: `voice:${callSid}`,
                settings: appointmentSettings,
              });

              console.log("[VOICE][APPOINTMENT_CREATED]", {
                callSid,
                appointmentId: appointment.id,
                tenantId: tenant.id,
              });

              const successStep = resolveBookingSuccessStep({ flow });

              if (!successStep) {
                throw new Error("BOOKING_SUCCESS_STEP_NOT_CONFIGURED");
              }

              const successPrompt = renderBookingTemplate(
                successStep.prompt,
                buildBookingPromptVariables({
                  bookingData: state.bookingData || {},
                  callerE164,
                })
              );

              const gather = vr.gather({
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

              gather.say(
                { language: currentLocale as any, voice: voiceName },
                twoSentencesMax(successPrompt)
              );

              await upsertVoiceCallState({
                callSid,
                tenantId: tenant.id,
                lang: state.lang ?? currentLocale,
                turn: state.turn ?? 0,
                awaiting: false,
                pendingType: null,
                awaitingNumber: false,
                altDest: state.altDest ?? null,
                smsSent: false,
                bookingStepIndex: null,
                bookingData: {},
              });

              return res.type('text/xml').send(vr.toString());
            } catch (err) {
              console.error("❌ Error creando cita:", err);

              const failRaw = cfg?.booking_error_message || "Hubo un problema al agendar la cita.";
              vr.say({ language: currentLocale as any, voice: voiceName }, twoSentencesMax(failRaw));
              vr.hangup();

              return res.type('text/xml').send(vr.toString());
            }
          }

          if (saidNo(userInput) || digits === "2") {
            await deleteVoiceCallState(callSid);

            const cancelRaw = cfg?.booking_cancel_message || "No se agendó la cita.";
            const gather = vr.gather({
              input: ['speech','dtmf'] as any,
              numDigits: 1,
              action: '/webhook/voice-response',
              method: 'POST',
              language: currentLocale as any,
            });

            gather.say({ language: currentLocale as any, voice: voiceName }, twoSentencesMax(cancelRaw));
            return res.type('text/xml').send(vr.toString());
          }

          const retry = twoSentencesMax(currentStep.prompt);
          const gather = vr.gather({
            input: ['speech','dtmf'] as any,
            numDigits: 1,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
          });

          gather.say({ language: currentLocale as any, voice: voiceName }, retry);
          return res.type('text/xml').send(vr.toString());
        }

        if (currentStep.expected_type === "phone") {
          const phoneResolution = resolvePhoneFromVoiceInput({
            userInput,
            digits,
            callerE164,
            step: currentStep,
          });

          if (!phoneResolution.ok) {
            const gather = vr.gather({
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

            gather.say(
              { language: currentLocale as any, voice: voiceName },
              twoSentencesMax(currentStep.retry_prompt || currentStep.prompt)
            );

            return res.type('text/xml').send(vr.toString());
          }

          const nextData: Record<string, string> = {
            ...(state.bookingData || {}),
            [currentStep.step_key]: phoneResolution.value,
          };

          const nextIndex = currentIndex + 1;
          const nextStep = flow[nextIndex];

          if (!nextStep) {
            await deleteVoiceCallState(callSid);
            throw new Error("BOOKING_CONFIRM_STEP_MISSING");
          }

          const prompt = renderBookingTemplate(
            nextStep.prompt,
            buildBookingPromptVariables({
              bookingData: nextData,
              callerE164,
            })
          );

          state = {
            ...state,
            bookingStepIndex: nextIndex,
            bookingData: nextData,
          };

          await upsertVoiceCallState({
            callSid,
            tenantId: tenant.id,
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: state.awaiting ?? false,
            pendingType: state.pendingType ?? null,
            awaitingNumber: state.awaitingNumber ?? false,
            altDest: state.altDest ?? null,
            smsSent: state.smsSent ?? false,
            bookingStepIndex: nextIndex,
            bookingData: nextData,
          });

          const isPhoneStep = nextStep.expected_type === "phone";
          const isConfirmationStep = nextStep.expected_type === "confirmation";

          const gather = vr.gather({
            input: isPhoneStep || isConfirmationStep ? ['speech', 'dtmf'] as any : ['speech'] as any,
            numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,
            actionOnEmptyResult: true,
            bargeIn: true,
          });

          gather.say(
            { language: currentLocale as any, voice: voiceName },
            twoSentencesMax(prompt)
          );

          return res.type('text/xml').send(vr.toString());
        }

        let resolvedStepValue = userInput;

        const rawSlot =
          typeof currentStep.validation_config?.slot === "string"
            ? currentStep.validation_config.slot.trim()
            : "";

        const isServiceStep =
          currentStep.step_key === "service" || rawSlot === "service";

        if (isServiceStep) {
          const serviceResolution = resolveVoiceBookingService({
            userInput,
            rawConfig: cfg?.booking_services_text || "",
          });

          if (serviceResolution.kind === "none") {
            const retryPrompt =
              currentStep.retry_prompt ||
              (currentLocale.startsWith("es")
                ? "No entendí bien el servicio que deseas agendar. ¿Cuál servicio quieres reservar?"
                : "I didn’t clearly catch the service you want to book. Which service would you like to book?");

            const gather = vr.gather({
              input: ['speech'] as any,
              action: '/webhook/voice-response',
              method: 'POST',
              language: currentLocale as any,
              speechTimeout: 'auto',
              timeout: 7,
              actionOnEmptyResult: true,
              bargeIn: true,
            });

            gather.say(
              { language: currentLocale as any, voice: voiceName },
              twoSentencesMax(retryPrompt)
            );

            return res.type('text/xml').send(vr.toString());
          }

          if (serviceResolution.kind === "ambiguous") {
            const optionsText = serviceResolution.options.join(", ");

            const ambiguousPrompt = currentLocale.startsWith("es")
              ? `Encontré varias opciones parecidas: ${optionsText}. Dime el nombre completo del servicio que quieres agendar.`
              : `I found several similar options: ${optionsText}. Please say the full service name you want to book.`;

            const gather = vr.gather({
              input: ['speech'] as any,
              action: '/webhook/voice-response',
              method: 'POST',
              language: currentLocale as any,
              speechTimeout: 'auto',
              timeout: 7,
              actionOnEmptyResult: true,
              bargeIn: true,
            });

            gather.say(
              { language: currentLocale as any, voice: voiceName },
              twoSentencesMax(ambiguousPrompt)
            );

            return res.type('text/xml').send(vr.toString());
          }

          resolvedStepValue = serviceResolution.value;
        }

        const isDatetimeStep =
          currentStep.step_key === "datetime" || rawSlot === "datetime";

        if (isDatetimeStep) {
          const currentBookingData = {
            ...(state.bookingData || {}),
            [currentStep.step_key]: resolvedStepValue,
          };

          const serviceName = String(
            currentBookingData.service || currentBookingData["service"] || ""
          ).trim();

          const rawDatetime = String(resolvedStepValue || "").trim();

          if (serviceName && rawDatetime) {
            const scheduleValidation = await resolveVoiceScheduleValidation({
              tenantId: tenant.id,
              serviceName,
              rawDatetime,
              channel: "voice",
            });

            if (!scheduleValidation.ok) {
              state = {
                ...state,
                bookingStepIndex: currentIndex,
                bookingData: currentBookingData,
              };

              await upsertVoiceCallState({
                callSid,
                tenantId: tenant.id,
                lang: state.lang ?? currentLocale,
                turn: state.turn ?? 0,
                awaiting: false,
                pendingType: null,
                awaitingNumber: false,
                altDest: state.altDest ?? null,
                smsSent: state.smsSent ?? false,
                bookingStepIndex: currentIndex,
                bookingData: currentBookingData,
              });

              const unavailablePrompt =
                typeof currentStep.validation_config?.unavailable_prompt === "string"
                  ? currentStep.validation_config.unavailable_prompt.trim()
                  : "";

              const availableTimes =
                scheduleValidation.reason === "schedule_not_available"
                  ? scheduleValidation.availableTimes.join(", ")
                  : "";

              const promptTemplate =
                scheduleValidation.reason === "schedule_not_available" && unavailablePrompt
                  ? unavailablePrompt
                  : (currentStep.retry_prompt || currentStep.prompt);

              const retryPrompt = twoSentencesMax(
                renderBookingTemplate(
                  promptTemplate,
                  {
                    ...buildBookingPromptVariables({
                      bookingData: currentBookingData,
                      callerE164,
                    }),
                    requested_service: String(currentBookingData.service || "").trim(),
                    requested_datetime: rawDatetime,
                    available_times: availableTimes,
                  }
                )
              );

              const gather = vr.gather({
                input: ['speech'] as any,
                action: '/webhook/voice-response',
                method: 'POST',
                language: currentLocale as any,
                speechTimeout: 'auto',
                timeout: 7,
                actionOnEmptyResult: true,
                bargeIn: true,
              });

              gather.say(
                { language: currentLocale as any, voice: voiceName },
                retryPrompt
              );

              logBotSay({
                callSid,
                to: didNumber || 'ivr',
                text: retryPrompt,
                lang: currentLocale,
                context: `booking_retry:${currentStep.step_key}`,
              });

              return res.type('text/xml').send(vr.toString());
            }
          }
        }

        const nextData = {
          ...(state.bookingData || {}),
          [currentStep.step_key]: resolvedStepValue,
        };

        const nextIndex = currentIndex + 1;
        const nextStep = flow[nextIndex];

        if (!nextStep) {
          await deleteVoiceCallState(callSid);
          throw new Error("BOOKING_CONFIRM_STEP_MISSING");
        }

        const prompt = renderBookingTemplate(
          nextStep.prompt,
          buildBookingPromptVariables({
            bookingData: nextData,
            callerE164,
          })
        );

        state = {
          ...state,
          bookingStepIndex: nextIndex,
          bookingData: nextData,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: state.awaiting ?? false,
          pendingType: state.pendingType ?? null,
          awaitingNumber: state.awaitingNumber ?? false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: nextIndex,
          bookingData: nextData,
        });

        const isPhoneStep = nextStep.expected_type === "phone";
        const isConfirmationStep = nextStep.expected_type === "confirmation";

        const gather = vr.gather({
          input: isPhoneStep || isConfirmationStep ? ['speech', 'dtmf'] as any : ['speech'] as any,
          numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
        });

        gather.say({ language: currentLocale as any, voice: voiceName }, twoSentencesMax(prompt));

        return res.type('text/xml').send(vr.toString());
      }

      const s = userInput.toLowerCase();

      const wantsPrices   = /(precio|precios|tarifa|tarifas|cost|price)/i.test(s);
      const wantsHours    = /(horario|horarios|abren|cierran|hours|open|close)/i.test(s);
      const wantsLocation = /(ubicaci[oó]n|direcci[oó]n|d[oó]nde|address|location|mapa|maps)/i.test(s);
      const wantsPayments = /(pago|pagar|checkout|buy|pay|payment)/i.test(s);

      const sayAndOffer = async (topic: 'precios'|'horarios'|'ubicacion'|'pagos', tipoLink: LinkType) => {
      const spokenRaw = await snippetFromPrompt({ topic, cfg, locale: currentLocale as any, brand });
      const spoken = sanitizeForSay(
        normalizeSpeechOutput(twoSentencesMax(spokenRaw), currentLocale as any)
      );
      vr.say({ language: currentLocale as any, voice: voiceName }, spoken);

      await offerSms(vr, currentLocale as any, voiceName, callSid, state, tipoLink, tenant.id);

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
          VALUES ($1, $2, $3::date, $4)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, CHANNEL_KEY, cicloInicio, totalTokens]
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
              AND canal = $2
              AND role = 'assistant'
              AND from_number = $3
            ORDER BY timestamp DESC
            LIMIT 1`,
          [tenant.id, CHANNEL_KEY, didNumber || 'sistema']
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

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    // Si rechazó, no enviamos
    if (!smsType && state.awaiting && (saidNo(userInput) || digits === '2')) {
      console.log('[VOICE/SMS] Usuario rechazó el SMS (estado).');

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
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

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: true,
          pendingType,
          awaitingNumber: state.awaitingNumber ?? false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });
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
        if (!isValidE164(preferred)) {
          const askNum = currentLocale.startsWith('es')
            ? '¿A qué número te lo envío? Dímelo con el código de país o márcalo ahora.'
            : 'What number should I text? Please include country code or key it in now.';

          await upsertVoiceCallState({
            callSid,
            tenantId: tenant.id,
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: false,
            pendingType: smsType,
            awaitingNumber: true,
            altDest: state.altDest ?? null,
            smsSent: state.smsSent ?? false,
            bookingStepIndex: state.bookingStepIndex ?? null,
            bookingData: state.bookingData ?? {},
          });

          vr.say({ language: currentLocale as any, voice: voiceName }, askNum);
          vr.gather({
            input: ['speech','dtmf'] as any,
            numDigits: 15,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 10,
            actionOnEmptyResult: true,
            bargeIn: true,
            enhanced: true,
            speechModel: 'phone_call',
            hints: currentLocale.startsWith('es')
              ? 'más, mas, signo, uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, cero, guion, espacio'
              : 'plus, one, two, three, four, five, six, seven, eight, nine, zero, dash, space'
          });

          return res.type('text/xml').send(vr.toString());
        }

        const confirm = currentLocale.startsWith('es')
          ? `Te lo envío al ${maskForVoice(preferred)}. Di "sí" o pulsa 1 para confirmar, o dicta otro número.`
          : `I'll text ${maskForVoice(preferred)}. Say "yes" or press 1 to confirm, or say another number.`;

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: true,
          pendingType: smsType,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });

        vr.say({ language: currentLocale as any, voice: voiceName }, confirm);
        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 15,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });

        return res.type('text/xml').send(vr.toString());
      }

      // Si thisTurnYes === true, seguimos abajo al bloque de envío
    }

    // ——— Si hay que mandar SMS ———
    if (smsType) {
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

          const chosen: { nombre?: string; url?: string } | null = linksByType[0] || null;

          if (!chosen?.url) {
            console.warn('[VOICE/SMS] No hay link para el tipo solicitado:', smsType);
            respuesta += currentLocale.startsWith('es')
              ? ' No encontré un enlace registrado para eso.'
              : ' I couldn’t find a saved link for that.';
          } else {
            const brand = await getTenantBrand(tenant.id);
            const body = `📎 ${chosen.nombre || 'Enlace'}: ${chosen.url}\n— ${brand}`;
            const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || '';

            const override = state.altDest && isValidE164(state.altDest) ? state.altDest : null;
            const toDest = override || callerE164;

            console.log('[VOICE/SMS] SENDING', {
              smsFrom,
              toDest,
              callerRaw,
              callSid,
              tenantId: tenant.id,
            });

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
            } else if (smsFrom.startsWith('whatsapp:')) {
              console.warn('[VOICE/SMS] El número configurado es WhatsApp; no envía SMS.');
              respuesta += currentLocale.startsWith('es')
                ? ' El número configurado es WhatsApp y no puede enviar SMS.'
                : ' The configured number is WhatsApp-only and cannot send SMS.';
            } else {
              const n = await sendSMS({
                mensaje: body,
                destinatarios: [toDest],
                fromNumber: smsFrom,
                tenantId: tenant.id,
                campaignId: null,
              });

              console.log('[VOICE/SMS] sendSMS -> enviados =', n);

              state = {
                ...state,
                awaiting: false,
                pendingType: null,
                smsSent: true,
              };

              await upsertVoiceCallState({
                callSid,
                tenantId: tenant.id,
                lang: state.lang ?? currentLocale,
                turn: state.turn ?? 0,
                awaiting: false,
                pendingType: null,
                awaitingNumber: state.awaitingNumber ?? false,
                altDest: state.altDest ?? null,
                smsSent: true,
                bookingStepIndex: state.bookingStepIndex ?? null,
                bookingData: state.bookingData ?? {},
              });

              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                VALUES ($1, 'system', $2, NOW(), $3, $4)`,
                [tenant.id, 'SMS enviado con link único.', CHANNEL_KEY, smsFrom]
              );

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
      }
    } else {
      console.log(
        '[VOICE/SMS] No se detectó condición para enviar SMS.',
        'userInput=',
        short(userInput),
        'respuesta=',
        short(respuesta)
      );
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
    const speakOut = sanitizeForSay(
      normalizeSpeechOutput(twoSentencesMax(respuesta), currentLocale as any)
    );

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

  contGather.say(
    { language: currentLocale as any, voice: voiceName },
    speakOut
  );

  const tailHelp = currentLocale.startsWith('es')
    ? 'Puedo ayudarte con precios, horarios o ubicación. Solo dime qué necesitas.'
    : 'I can help with prices, hours, or location. Just tell me what you need.';

  contGather.say(
    { language: currentLocale as any, voice: voiceName },
    tailHelp
  );
    } else {
      await deleteVoiceCallState(callSid);

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        currentLocale.startsWith('es')
          ? 'Gracias por tu llamada. ¡Hasta luego!'
          : 'Thanks for calling. Goodbye!'
      );

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
  vrErr.say({ language: errLocale as any, voice: resolveVoice('es-ES') as any }, errText);
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
