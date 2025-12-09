// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildDudaSlug, isDirectIntent, normalizeIntentAlias } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido } from '../../lib/respuestasTraducidas';
import { enviarWhatsApp } from '../../lib/senders/whatsapp';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';

// ⬇️ Importa también esIntencionDeVenta para contar ventas correctamente
import { detectarIntencion, esIntencionDeVenta } from '../../lib/detectarIntencion';

import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import { buscarRespuestaPorIntencion } from "../../services/intent-matcher";
import { extractEntitiesLite } from '../../utils/extractEntitiesLite';
import { getFaqByIntent } from "../../utils/getFaqByIntent";
import { answerMultiIntent, detectTopIntents } from '../../utils/multiIntent';
import type { Canal } from '../../lib/detectarIntencion';
import { tidyMultiAnswer } from '../../utils/tidyMultiAnswer';
import { requireChannelEnabled } from "../../middleware/requireChannelEnabled";
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { cycleStartForNow } from '../../utils/billingCycle';
import {
  saludoPuroRegex,
  smallTalkRegex,
  buildSaludoConversacional,
  buildSaludoSmallTalk,
  graciasPuroRegex,
  buildGraciasRespuesta,
} from '../../lib/saludosConversacionales';
import { answerWithPromptBase } from '../../lib/answers/answerWithPromptBase';
import { getIO } from '../../lib/socket';
import { incrementarUsoPorCanal } from '../../lib/incrementUsage';

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

const PRICE_REGEX = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
const MATCHER_MIN_OVERRIDE = 0.85; // exige score alto para sobreescribir una intención "directa"

const MAX_WHATSAPP_LINES = 16; // 14–16 es el sweet spot

const INTENT_THRESHOLD = Math.min(
  0.95,
  Math.max(0.30, Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55))
);

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const INTENTS_DIRECT = new Set([
  'interes_clases',
  'precio',
  'horario',
  'ubicacion',
  'reservar',
  'comprar',
  'confirmar',
  'clases_online',
  'saludo',          // 👈 NUEVO
  'agradecimiento',  // 👈 NUEVO
]);

// Intenciones que deben ser únicas por tenant/canal
const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  if (Number.isFinite(m) && m > 0) return m;
  return fallbackMin;
}

// Acceso a DB para idioma del contacto
async function getIdiomaClienteDB(tenantId: string, contacto: string, fallback: 'es'|'en'): Promise<'es'|'en'> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma FROM clientes WHERE tenant_id = $1 AND contacto = $2 LIMIT 1`,
      [tenantId, contacto]
    );
    if (rows[0]?.idioma) return normalizeLang(rows[0].idioma);
  } catch {}
  return fallback;
}

async function upsertIdiomaClienteDB(tenantId: string, contacto: string, idioma: 'es'|'en') {
  try {
    await pool.query(
      `INSERT INTO clientes (tenant_id, contacto, idioma)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, contacto)
       DO UPDATE SET idioma = EXCLUDED.idioma`,
      [tenantId, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

async function translateCTAIfNeeded(
  cta: { cta_text: string; cta_url: string } | null,
  idiomaDestino: 'es'|'en'
) {
  if (!cta) return null;
  let txt = (cta.cta_text || '').trim();
  try {
    // si el idioma destino es EN y el CTA no parece inglés, tradúcelo;
    // (o traduce siempre a idiomaDestino si prefieres)
    const lang = await detectarIdioma(txt).catch(() => null);
    if (lang && lang !== 'zxx' && ((idiomaDestino === 'en' && !/^en/i.test(lang)) ||
                                   (idiomaDestino === 'es' && !/^es/i.test(lang)))) {
      txt = await traducirMensaje(txt, idiomaDestino);
    } else if (!lang) {
      // sin detección: fuerza a idiomaDestino por seguridad
      txt = await traducirMensaje(txt, idiomaDestino);
    }
  } catch {}
  return { cta_text: txt, cta_url: cta.cta_url };
}

// ⬇️ Helper único para registrar INTENCIÓN DE VENTA (evita duplicar lógica)
async function recordSalesIntent(
  tenantId: string,
  contacto: string,
  canal: string,
  mensaje: string,
  intencion: string,
  nivel_interes: number,
  messageId: string | null
) {
  if (!messageId) return;
  if (!esIntencionDeVenta(intencion)) return; // solo cuenta si es venta
  try {
    await pool.query(
      `INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
      [tenantId, contacto, canal, mensaje, intencion, nivel_interes, messageId]
    );

  } catch (e) {
    console.warn('⚠️ No se pudo insertar en sales_intelligence (WA):', e);
  }
}

function pickIntentForCTA(
  opts: {
    canonical?: string | null;     // INTENCION_FINAL_CANONICA
    matcher?: string | null;       // respIntent.intent
    firstOfTop?: string | null;    // top[0]?.intent en multi-intent
    fallback?: string | null;      // intenCanon u otras
    prefer?: string | null;        // fuerza (ej. 'precio' si el user pidió precios)
  }
) {
  const cand = [
    opts.prefer?.trim().toLowerCase(),
    opts.matcher?.trim().toLowerCase(),
    opts.firstOfTop?.trim().toLowerCase(),
    opts.canonical?.trim().toLowerCase(),
    opts.fallback?.trim().toLowerCase()
  ];
  return cand.find(Boolean) || null;
}

function appendCTAWithCap(
  text: string,
  cta: { cta_text: string; cta_url: string } | null
) {
  if (!cta) return text;
  const extra = `\n\n${cta.cta_text}: ${cta.cta_url}`;
  const lines = text.split('\n'); // ❗️ no filtramos vacías
  const limit = Math.max(0, MAX_WHATSAPP_LINES - 2); // deja 2 líneas para CTA
  if (lines.length > limit) {
    return lines.slice(0, limit).join('\n') + extra;
  }
  return text + extra;
}

// Evita enviar duplicado si Twilio reintenta el webhook
async function safeEnviarWhatsApp(
  tenantId: string,
  canal: string,
  messageId: string | null,
  toNumber: string,
  text: string
) {
  try {
    // Caso sin messageId (por seguridad)
    if (!messageId) {
      await enviarWhatsApp(toNumber, text, tenantId);
      await incrementarUsoPorCanal(tenantId, canal); // ✅ cuenta SOLO respuesta del bot
      return;
    }

    const { rows: sent } = await pool.query(
      `SELECT 1
         FROM interactions
        WHERE tenant_id = $1
          AND canal = $2
          AND message_id = $3
        LIMIT 1`,
      [tenantId, canal, messageId]
    );

    if (!sent[0]) {
      // 👉 Primera vez que respondemos este message_id
      await enviarWhatsApp(toNumber, text, tenantId);
      await incrementarUsoPorCanal(tenantId, canal); // ✅ suma 1 SOLO si realmente se envía
    } else {
      console.log('⏩ safeEnviarWhatsApp: ya se envió este message_id, no se duplica ni se cuenta.');
    }
  } catch (e) {
    console.error('❌ safeEnviarWhatsApp error:', e);
    // Último intento: enviar y contar (mejor sobrecontar un poco que no responder)
    try {
      await enviarWhatsApp(toNumber, text, tenantId);
      await incrementarUsoPorCanal(tenantId, canal);
    } catch {}
  }
}

// ⬇️ AQUÍ VA EL HELPER NUEVO
async function saveAssistantMessageAndEmit(opts: {
  tenantId: string;
  canal: string;
  fromNumber: string;
  messageId: string | null;
  content: string;
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenantId, content, canal, fromNumber || 'anónimo', finalMessageId]
    );

    const inserted = rows[0];
    if (!inserted) {
      // ya existía → no emitimos nada
      return;
    }

    const io = getIO();
    if (!io) {
      console.warn('⚠️ [SOCKET] getIO() devolvió null al guardar assistant.');
      return;
    }

    const payload = {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
    };

    console.log('📡 [SOCKET] Emitting message:new (assistant)', payload);
    io.emit('message:new', payload);
  } catch (e) {
    console.warn('⚠️ No se pudo registrar mensaje assistant + socket:', e);
  }
}

router.post("/", async (req: Request, res: Response) => {
  try {
    // Responde a Twilio de inmediato
    res.type("text/xml").send(new MessagingResponse().toString());

    // Procesa el mensaje aparte (no bloquea la respuesta a Twilio)
    setTimeout(async () => {
      await procesarMensajeWhatsApp(req.body);
    }, 0);
  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.status(500).send("Error interno");
  }
});

export default router;

export async function procesarMensajeWhatsApp(
  body: any,
  context?: WhatsAppContext
): Promise<void> {
  let alreadySent = false;

  // Datos básicos del webhook
  const to = body?.To || '';
  const from = body?.From || '';
  const userInput = body?.Body || '';
  const messageId = body?.MessageSid || body?.SmsMessageSid || null;

  // Números “limpios”
  const numero      = to.replace('whatsapp:', '').replace('tel:', '');   // número del negocio
  const fromNumber  = from.replace('whatsapp:', '').replace('tel:', ''); // número del cliente

  // Normaliza variantes con / sin "+" para que coincida aunque en DB esté "1555..." o "+1555..."
  const numeroSinMas = numero.replace(/^\+/, '');

  console.log('🔎 numero normalizado =', { numero, numeroSinMas });

  // 👉 1) intenta usar el tenant que viene en el contexto (Meta / otros canales)
  let tenant = context?.tenant as any | undefined;

  // 👉 2) si no viene en el contexto (caso Twilio), haz el lookup por número
  if (!tenant) {
    const tenantRes = await pool.query(
      `
        SELECT *
        FROM tenants
        WHERE twilio_number = $1
           OR whatsapp_phone_number = $1
           OR twilio_number = $2
           OR whatsapp_phone_number = $2
        LIMIT 1
      `,
      [numero, numeroSinMas]
    );
    tenant = tenantRes.rows[0];
  }

  if (!tenant) {
    console.log('⛔ No se encontró tenant para este número de WhatsApp.');
    return;
  }

  // Si no hay membresía activa: no respondas
  if (!tenant.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se responderá.`);
    return;
  }

  // // canal puede venir en el contexto (meta/preview) o por defecto 'whatsapp'
  const canal: Canal = (context?.canal as Canal) || 'whatsapp';

  // 👉 detectar si el mensaje es solo numérico (para usar idioma previo)
  const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

  // 👉 idioma base del tenant (fallback)
  const tenantBase: 'es' | 'en' = normalizeLang(tenant?.idioma || 'es');

  let idiomaDestino: 'es'|'en';

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, fromNumber, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(userInput)); } catch {}
    const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
    await upsertIdiomaClienteDB(tenant.id, fromNumber, normalizado);
    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userInput`);
  }

  // 🛡️ Anti-phishing (EARLY EXIT antes de guardar mensajes/uso/tokens)
  {
    const handledPhishing = await antiPhishingGuard({
      pool,
      tenantId: tenant.id,
      channel: "whatsapp",
      senderId: fromNumber,     // número del cliente
      messageId,                // SID de Twilio
      userInput,                // texto recibido
      idiomaDestino,            // ✅ igual que en Meta
      send: async (text: string) => {
        // ✅ usa el wrapper que también contabiliza uso_mensual
        await safeEnviarWhatsApp(tenant.id, 'whatsapp', messageId, fromNumber, text);
      },
    });

    if (handledPhishing) {
      // Ya respondió con mensaje seguro, marcó spam y cortó el flujo.
      return;
    }
  }

  // 2.a) Guardar el mensaje del usuario una sola vez (idempotente) + emitir por socket
  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenant.id, userInput, 'whatsapp', fromNumber || 'anónimo', messageId]
    );

    const inserted = rows[0];

    // Solo emitimos si realmente se insertó (no hubo conflicto ON CONFLICT)
    if (inserted) {
      const io = getIO();
      if (io) {
        const payload = {
          id: inserted.id,
          // mando ambas por si acaso: created_at y timestamp
          created_at: inserted.timestamp,
          timestamp: inserted.timestamp,
          role: inserted.role,
          content: inserted.content,
          canal: inserted.canal,
          from_number: inserted.from_number,
        };

        console.log('📡 [SOCKET] Emitting message:new', payload);

        // 👇 GLOBAL (sin room) para que todos los sockets lo reciban
        io.emit('message:new', payload);
      } else {
        console.warn('⚠️ [SOCKET] getIO() devolvió null, no se emitió message:new');
      }
    }
  } catch (e) {
    console.warn('No se pudo registrar mensaje user:', e);
  }

  const idioma = await detectarIdioma(userInput);
  
  function stripLeadGreetings(t: string) {
    return t
      .replace(/^\s*(hola+[\s!.,]*)?/i, '')
      .replace(/^\s*(saludos+[\s!.,]*)?/i, '')
      .replace(/^\s*(hello+|hi+|hey+)[\s!.,]*/i, '')
      .trim();
  }

  // 🧹 Cancela cualquier follow-up pendiente para este contacto al recibir nuevo mensaje
  try {
    await pool.query(
      `DELETE FROM mensajes_programados
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
      [tenant.id, canal, fromNumber]
    );
    console.log('🧽 Follow-ups pendientes limpiados (WA):', { tenantId: tenant.id, fromNumber });
  } catch (e) {
    console.warn('No se pudieron limpiar follow-ups pendientes:', e);
  }

  let faqs: any[] = [];
  try {
    const faqsRes = await pool.query(
      'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );    
    faqs = faqsRes.rows || [];
  } catch (err) {
    console.error("❌ Error cargando FAQs:", err);
    faqs = [];
  }  

  const mensajeUsuario = normalizarTexto(stripLeadGreetings(userInput));

  // Texto sin saludos al inicio para detectar "más info" y "demo"
  const cleanedForInfo = stripLeadGreetings(userInput);
  const cleanedNorm    = normalizarTexto(cleanedForInfo);

  // 🔍 CASO ESPECIAL: usuario pide "más info" de forma muy genérica
  const wantsMoreInfoEn =
    /\b(need\s+more\s+in(?:f|fo|formation)|i\s+want\s+more\s+in(?:f|fo|formation)|more\s+in(?:f|fo|formation))\b/i
      .test(cleanedForInfo);

  const wantsMoreInfoEs =
    /\b((necesito|quiero)\s+mas\s+in(?:f|fo|formacion)|mas\s+info|mas\s+informacion)\b/i
      .test(cleanedNorm);

  // 🆕 Detector flexible de mensajes pidiendo "más info"
  const wantsMoreInfoDirect = [
    "info",
    "informacion",
    "información",
    "mas info",
    "más info",
    "more info",
    "more information",
    "more details",
    "more detail",
    "information",
    "details"
  ];

  // 🆕 Expresiones adicionales de cierre
  const trailing = /(pls?|please|por\s*fa(vor)?)/i;

  // Limpieza para comparar bien
  const msg = cleanedNorm.toLowerCase();

  // REGEX FLEXIBLE: detecta cualquier frase que contenga una palabra de la lista
  const shortInfoOnly =
    wantsMoreInfoDirect.some(k => msg.includes(k)) ||
    trailing.test(msg);

  const wantsMoreInfo = wantsMoreInfoEn || wantsMoreInfoEs || shortInfoOnly;

  // 🔍 CASO ESPECIAL: usuario pide una DEMO / demostración
  const wantsDemo =
    /\b(demuéstramelo|demuestrame|demuestrame|hazme una demostracion|hazme un demo|prueba real|ejemplo real|muestrame como funciona|muestrame como responde|show me|prove it|give me a demo)\b/i
      .test(cleanedNorm);

  // Prompt base del tenant para todo este flujo
  const promptBase = getPromptPorCanal('whatsapp', tenant, idiomaDestino);
  let respuesta: any = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

  // CTA multilenguaje para cierres consistentes
  const CTA_TXT =
    idiomaDestino === 'en'
      ? 'Is there anything else I can help you with?'
      : '¿Hay algo más en lo que te pueda ayudar?';

  // ⬇️ No empujar CTA si el mensaje es solo saludo / gracias / ok
  const isSmallTalkOrCourtesy =
    /^(hola|hello|hi|hey|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|thank\s+you|ok|okay|vale|perfecto)\b/i
      .test(userInput.trim());

  // 🧩 Bloque especial: "quiero más info / need more info"
  if (wantsMoreInfo) {
    const startsWithGreeting = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?|buenas|buenos\s+(dias|días))/i
      .test(userInput);

    let reply: string;

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

      const systemPrompt = [
        promptBase,
        '',
        `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
        `Formato WhatsApp: mensajes MUY CORTOS (máx. 3-4 frases, 6-8 líneas como máximo), sin párrafos largos.`,
        `No uses viñetas, listas ni encabezados. Solo texto corrido, claro y directo.`,
        // 🔴 NUEVO: nada de links ni correos ni precios exactos
        'No menciones correos, páginas web ni enlaces (no escribas "http", "www" ni "@").',
        'No des precios concretos, montos, ni duración exacta de pruebas (solo describe de forma general).',
        'Usa exclusivamente la información del negocio (servicios, tipo de clientes, forma general de empezar).',
        'No repitas siempre la misma presentación; responde adaptándote a lo que el cliente pide.'
      ].join('\n');

      const userPromptLLM =
        idiomaDestino === 'en'
          ? `The user is asking for general information (e.g. "I need more info", "I want more information", "more info pls").
Using ONLY the business information in the prompt, write a VERY SHORT explanation (2-3 sentences) that says:
- what this business does,
- who it is for,
Do NOT include prices, discounts, trial days, email addresses, websites or any links.
Avoid marketing or hype. Be simple and clear.
Avoid repeating these instructions or explaining what you are doing; just answer as if you were the business.
End with this exact question in English:
"What would you like to know more about? Our services, prices, or something else?"`
          : `El usuario está pidiendo información general (por ejemplo "quiero más info", "necesito más información", "más info pls").
Usando SOLO la información del negocio en el prompt, escribe una explicación MUY CORTA (2-3 frases) que diga:
- qué hace este negocio,
- para quién es,
No incluyas precios, descuentos, días de prueba, correos electrónicos, páginas web ni ningún enlace.
Evita sonar a anuncio o landing page; sé simple y claro.
No repitas estas instrucciones ni expliques lo que estás haciendo; responde como si fueras el negocio.
Termina con esta pregunta EXACTA en español:
"¿Sobre qué te gustaría saber más? ¿Servicios, precios, u otra cosa?"`;

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPromptLLM },
        ],
      });

      reply =
        completion.choices[0]?.message?.content?.trim() ??
        (idiomaDestino === 'en'
          ? 'What would you like to know more about? Our services, prices, schedule, or something else?'
          : '¿Sobre qué te gustaría saber más? ¿Servicios, precios, horarios u otra cosa?');

      // registra tokens
      const used = completion.usage?.total_tokens || 0;
      if (used > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, used]
        );
      }
    } catch (e) {
      console.warn('⚠️ LLM (more info) falló; uso fallback fijo:', e);
      reply =
        idiomaDestino === 'en'
          ? 'What would you like to know more about? Our services, prices, schedule, or something else?'
          : '¿Sobre qué te gustaría saber más? ¿Servicios, precios, horarios u otra cosa?';
    }

    // Si el mensaje venía CON saludo al inicio, antepone la bienvenida
    if (startsWithGreeting) {
      const saludo = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
      reply = `${saludo}\n\n${reply}`;
    }

    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, reply);

    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: reply,
    });

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    try {
      await recordSalesIntent(
        tenant.id,
        fromNumber,
        canal,
        userInput,
        'pedir_info',
        2,
        messageId
      );
    } catch (e) {
      console.warn('⚠️ No se pudo registrar sales_intelligence (more info):', e);
    }

    return;
  }

  // 🧩 Bloque especial: DEMOSTRACIÓN ("demuéstramelo", "show me", etc.)
  if (wantsDemo) {
    // Saludo dinámico, ya multicanal/multitenant
    const saludo = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

    const demoTextEs =
      'Puedo responderte tanto en inglés como en español. ' +
      'Pregúntame lo que quieras sobre nuestros servicios, precios u otra cosa ' +
      'y te responderé en tu idioma.';

    const demoTextEn =
      'I can reply in both English and Spanish. ' +
      'You can ask me anything about our services, prices or anything else, ' +
      'and I will answer in your language.';

    const reply =
      idiomaDestino === 'en'
        ? `${saludo}\n\n${demoTextEn}`
        : `${saludo}\n\n${demoTextEs}`;

    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, reply);

    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: reply,
    });

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    // Registramos intención "demo" como interés medio
    try {
      await recordSalesIntent(
        tenant.id,
        fromNumber,
        canal,
        userInput,
        'demo',
        2,
        messageId
      );
    } catch (e) {
      console.warn('⚠️ No se pudo registrar sales_intelligence (demo):', e);
    }

    return;
  }

  // === FAST-PATH MULTI-INTENCIÓN ===
  try {
    const top = await detectTopIntents(userInput, tenant.id, canal as Canal, 3);
    console.log('[MULTI] top=', top);

    const hasPrecio = top.some(t => t.intent === 'precio');
    const hasInfo   = top.some(t => t.intent === 'interes_clases' || t.intent === 'pedir_info');
    const multiAsk  = top.length >= 2 || (hasPrecio && hasInfo);

    console.log('[MULTI] hasPrecio=', hasPrecio, 'hasInfo=', hasInfo, 'len=', top.length, 'multiAsk=', multiAsk);

    if (multiAsk) {
      const multi = await answerMultiIntent({ tenantId: tenant.id, canal: canal as Canal, userText: userInput, idiomaDestino, promptBase });

      console.log('[MULTI] answer length=', multi?.text?.length ?? 0);

      if (multi) {
      let multiText = multi.text || '';

      const askedSchedule = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);
      const askedPrice    = PRICE_REGEX.test(userInput);

      const hasPriceInText    = /\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(multiText); // añade S/ por si acaso
      const hasScheduleInText = /\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i.test(multiText);

      // ⬇️ PREPEND precios si faltan
      if (askedPrice && !hasPriceInText) {
        try {
          const precioFAQ = await fetchFaqPrecio(tenant.id, canal);
          if (precioFAQ?.trim()) {
            multiText = [precioFAQ.trim(), '', multiText.trim()].join('\n\n'); // <— PREPEND
          }
        } catch (e) {
          console.warn('⚠️ No se pudo anexar FAQ precios en MULTI:', e);
        }
      }

      // ⬇️ APPEND horario si falta
      if (askedSchedule && !hasScheduleInText) {
        try {
          const hitH = await getFaqByIntent(tenant.id, canal, 'horario');
          if (hitH?.respuesta?.trim()) {
            multiText = [multiText.trim(), '', hitH.respuesta.trim()].join('\n\n'); // <— APPEND
          }
        } catch (e) {
          console.warn('⚠️ No se pudo anexar FAQ horario en MULTI:', e);
        }
      }

      // Asegura idioma de salida por si acaso
      try {
        const langOut = await detectarIdioma(multiText);
        if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
          multiText = await traducirMensaje(multiText, idiomaDestino);
        }
      } catch {}

      // Usa el CTA según idioma (asegúrate de haber definido CTA_TXT tras calcular idiomaDestino)
      const out = tidyMultiAnswer(multiText, {
        maxLines: MAX_WHATSAPP_LINES - 2, // deja espacio al CTA
        freezeUrls: true,
        cta: CTA_TXT
      });

      
      // ⬇️ CTA por intención (multi-intent)
      const prefer = askedPrice ? 'precio' : (askedSchedule ? 'horario' : null);
      const intentForCTA = pickIntentForCTA({
        firstOfTop: top?.[0]?.intent || null,
        prefer
      });
      
      const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
      const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
      const outWithCTA = appendCTAWithCap(out, ctaX);

      await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, outWithCTA);

      alreadySent = true;

      // ⬇️ Fallback: si pidió precios y el mensaje final no los trae, manda un resumen breve
      if (askedPrice && !(/\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(out))) {
        try {
          const precioFAQ = await fetchFaqPrecio(tenant.id, canal);
          if (precioFAQ?.trim()) {
            // Tomar 2–3 líneas con montos
            const resumen = precioFAQ
              .split('\n')
              .filter(l => /\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(l))
              .slice(0, 3)
              .join('\n');
            if (resumen) {
              await enviarWhatsApp(fromNumber, resumen, tenant.id);
              alreadySent = true;

            }
          }
        } catch {}
      }
      
        await saveAssistantMessageAndEmit({
          tenantId: tenant.id,
          canal,
          fromNumber: fromNumber || 'anónimo',
          messageId,
          content: outWithCTA,
        });

        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT DO NOTHING`,
          [tenant.id, canal, messageId]
        );

        // 🔔 Registrar venta si aplica + follow-up
        try {
          const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
          const intFinal = normalizeIntentAlias(det?.intencion || '');
          await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, det?.nivel_interes ?? 1, messageId);
          await scheduleFollowUp(intFinal, det?.nivel_interes ?? 1);
        } catch (e) {
          console.warn('⚠️ No se pudo registrar sales_intelligence en fast-path:', e);
        }

        return; // ⬅️ salida fast-path
      }
    }
  } catch (e) {
    console.warn('⚠️ Multi-intent fast-path falló; sigo pipeline normal:', e);
  }

  // CTA por intención (usa tenant_ctas.intent_slug en TEXT, no UUID)
  async function getTenantCTA(tenantId: string, intent: string, channel: string) {
    const inten = normalizeIntentAlias((intent || '').trim().toLowerCase());

    // 1) Coincidencia exacta por canal o comodín '*'
    let q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = $2
        AND (canal = $3 OR canal = '*')
      ORDER BY CASE WHEN canal=$3 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, inten, channel]
    );
    if (q.rows[0]) return q.rows[0];

    // 2) Fallback 'global' del mismo canal (o '*')
    q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = 'global'
        AND (canal = $2 OR canal = '*')
      ORDER BY CASE WHEN canal=$2 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, channel]
    );
    return q.rows[0] || null;
  }

  // ✅ Valida URL simple
  function isValidUrl(u?: string) {
    try {
      if (!u) return false;
      if (!/^https?:\/\//i.test(u)) return false;
      new URL(u);
      return true;
    } catch {
      return false;
    }
  }

  // ✅ CTA “global” guardada en las columnas del tenant (no en tenant_ctas)
  function getGlobalCTAFromTenant(tenant: any) {
    const t = (tenant?.cta_text || '').trim();
    const u = (tenant?.cta_url  || '').trim();
    if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
    return null;
  }

  // Selecciona CTA por intención; si no hay, usa CTA global del tenant
  async function pickCTA(tenant: any, intent: string | null, channel: string) {
  if (intent) {
    const byIntent = await getTenantCTA(tenant.id, intent, channel);
    if (byIntent) return byIntent;
  }
  // fallback opcional desde columnas del tenant (si las usas)
  const t = (tenant?.cta_text || '').trim();
  const u = (tenant?.cta_url  || '').trim();
  if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
  return null;
}

  // ⏲️ Programador de follow-up (WhatsApp)
  async function scheduleFollowUp(intFinal: string, nivel: number) {
    try {
      const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
      const condition = (nivel >= 3) || intencionesFollowUp.includes((intFinal || '').toLowerCase());
      console.log('⏩ followup gate (WA)', { intFinal, nivel, condition });
      if (!condition) return;

      // Config tenant
      const { rows: cfgRows } = await pool.query(
        `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
        [tenant.id]
      );
      const cfg = cfgRows[0];
      if (!cfg) {
        console.log('⚠️ Sin follow_up_settings; no se programa follow-up.');
        return;
      }

      // Selección del mensaje por intención
      let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
      const low = (intFinal || '').toLowerCase();
      if (low.includes("precio") && cfg.mensaje_precio) {
        msg = cfg.mensaje_precio;
      } else if ((low.includes("agendar") || low.includes("reservar")) && cfg.mensaje_agendar) {
        msg = cfg.mensaje_agendar;
      } else if ((low.includes("ubicacion") || low.includes("location")) && cfg.mensaje_ubicacion) {
        msg = cfg.mensaje_ubicacion;
      }

      // Asegura idioma del cliente
      try {
        const lang = await detectarIdioma(msg);
        if (lang && lang !== 'zxx' && lang !== idiomaDestino) {
          msg = await traducirMensaje(msg, idiomaDestino);
        }
      } catch {}

      // Evita duplicados: borra pendientes no enviados
      await pool.query(
        `DELETE FROM mensajes_programados
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenant.id, 'whatsapp', fromNumber]
      );

      const delayMin = getConfigDelayMinutes(cfg, 60);
      const fechaEnvio = new Date();
      fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

      const { rows } = await pool.query(
        `INSERT INTO mensajes_programados
          (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
        VALUES ($1, $2, $3, $4, $5, false)
        RETURNING id`,
        [tenant.id, 'whatsapp', fromNumber, msg, fechaEnvio]
      );

      console.log('📅 Follow-up programado (WA)', {
        id: rows[0]?.id,
        tenantId: tenant.id,
        contacto: fromNumber,
        delayMin,
        fechaEnvio: fechaEnvio.toISOString(),
      });
    } catch (e) {
      console.warn('⚠️ No se pudo programar follow-up (WA):', e);
    }
  };

    // 💬 Small-talk tipo "hello how are you" / "hola como estas"
  if (smallTalkRegex.test(userInput.trim())) {
    const saludoSmall = buildSaludoSmallTalk(tenant, idiomaDestino);

    // 1) Enviar saludo corto y humano
    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, saludoSmall);

    // 2) Registrar mensaje del bot
    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: saludoSmall,
    });

    // 3) Registrar interacción
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    return;
  }

  // 💬 Saludo puro: "hola", "hello", "buenas", etc.
  if (saludoPuroRegex.test(userInput.trim())) {
    const saludo = buildSaludoConversacional(tenant, idiomaDestino);

    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, saludo);

    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: saludo,
    });

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    return;
  }

    // 🙏 Mensaje de solo "gracias / thank you / thanks"
  if (graciasPuroRegex.test(userInput.trim())) {
    const respuesta = buildGraciasRespuesta(idiomaDestino);

    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, respuesta);

    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: respuesta,
    });

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    return;
  }

  // 🔎 Intención antes del EARLY RETURN
  const { intencion: intenTemp } = await detectarIntencion(userInput, tenant.id, 'whatsapp');
  const intenCanon = normalizeIntentAlias((intenTemp || '').toLowerCase());

  // 👉 si es directa, NO hagas early return; deja que pase al pipeline de FAQ
  const esDirecta = INTENTS_DIRECT.has(intenCanon);

  if (!esDirecta) {
    console.log('🛣️ Ruta: EARLY_RETURN con promptBase (no directa). Intención =', intenCanon);

    try {
      const fallbackBienvenida = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

      const { text } = await answerWithPromptBase({
        tenantId: tenant.id,
        promptBase,
        userInput,
        idiomaDestino,
        canal: 'whatsapp',
        maxLines: MAX_WHATSAPP_LINES,
        fallbackText: fallbackBienvenida,
      });

      let out = text;

      // ⬇️ CTA por intención (early return)
      const intentForCTA = pickIntentForCTA({
        fallback: intenCanon, // ya calculaste intenCanon antes
      });

      const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
      const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
      const outWithCTA = isSmallTalkOrCourtesy
        ? out                         // ❌ NO CTA si es saludo / gracias / ok
        : appendCTAWithCap(out, ctaX); // ✅ CTA normal en el resto de casos

      await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, outWithCTA);
      alreadySent = true;

      await saveAssistantMessageAndEmit({
        tenantId: tenant.id,
        canal, // aquí ya vale 'whatsapp'
        fromNumber: fromNumber || 'anónimo',
        messageId,
        content: outWithCTA,
      });

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [tenant.id, canal, messageId]
      );

      // (Opcional) métricas / follow-up + registrar venta si aplica
      try {
        const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
        const nivel = det?.nivel_interes ?? 1;
        const intFinal = normalizeIntentAlias((det?.intencion || '').toLowerCase());
        await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, nivel, messageId);

        if (nivel >= 3 || ["interes_clases","reservar","precio","comprar","horario"].includes(intFinal)) {
          await scheduleFollowUp(intFinal, nivel);
        }
      } catch (e) {
        console.warn('⚠️ No se pudo registrar sales_intelligence en EARLY_RETURN (WA):', e);
      }

      return; // ✅ Solo retornas si hiciste EARLY RETURN OK
    } catch (e) {
      console.warn('❌ EARLY_RETURN helper falló; sigo con pipeline FAQ/intents:', e);
      // ⛔️ Sin return aquí: continúa al pipeline de FAQ / intents
    }
  } else {
    console.log('🛣️ Ruta: FAQ/Intents (intención directa). Intención =', intenCanon);
  }

  // después de calcular idiomaDestino...
  let INTENCION_FINAL_CANONICA = '';

  // 3️⃣ Detectar intención
  const { intencion: intencionDetectada } = await detectarIntencion(mensajeUsuario, tenant.id, 'whatsapp');
  const intencionLower = intencionDetectada?.trim().toLowerCase() || "";
  console.log(`🧠 Intención detectada al inicio para tenant ${tenant.id}: "${intencionLower}"`);

  let intencionProc = intencionLower; // se actualizará tras traducir (si aplica)
  let intencionParaFaq = intencionLower; // esta será la que usemos para consultar FAQ

  // 🔄 INTENCIÓN: Solo "agradecimiento"
  // (Los saludos ya están manejados arriba con regex → DO NOT DUPLICATE)
  if (intencionLower === "agradecimiento" && graciasPuroRegex.test(userInput.trim())) {
    let respuesta = "";

    if (idiomaDestino === 'en') {
      respuesta = "You're welcome! If you need anything else, just let me know.";
    } else {
      respuesta = "¡Con gusto! Si necesitas algo más, solo dime.";
    }

    try {
      await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, respuesta);

      await saveAssistantMessageAndEmit({
        tenantId: tenant.id,
        canal,
        fromNumber: fromNumber || 'anónimo',
        messageId,
        content: respuesta,
      });

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING`,
        [tenant.id, canal, messageId]
      );

      return;
    } catch (err) {
      console.error("❌ Error enviando respuesta rápida de agradecimiento:", err);
      // Continuar al flujo normal si hay error
    }
  }

    // Paso 1: Detectar idioma y traducir para evaluar intención
    const textoTraducido = idiomaDestino !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

    // ✅ NUEVO: quitar saludos al inicio para no sesgar la intención
    const textoParaIntent = stripLeadGreetings(textoTraducido);

    const { intencion: intencionProcesada } =
      await detectarIntencion(textoParaIntent, tenant.id, 'whatsapp');

    intencionProc = (intencionProcesada || '').trim().toLowerCase();
    intencionParaFaq = intencionProc;
    console.log(`🧠 Intención detectada (procesada): "${intencionProc}"`);

    // Refina dudas a sub-slug
    if (intencionProc === 'duda') {
      const refined = buildDudaSlug(userInput);
      console.log(`🎯 Refino duda → ${refined}`);
      intencionProc = refined;
      intencionParaFaq = refined;
    }

    // Canonicaliza
    intencionProc = normalizeIntentAlias(intencionProc);
    intencionParaFaq = normalizeIntentAlias(intencionParaFaq);

    INTENCION_FINAL_CANONICA = (intencionParaFaq || intencionProc || '').trim().toLowerCase();
    console.log(`🎯 Intención final (canónica) = ${INTENCION_FINAL_CANONICA}`);

    // 👉 Detección de temporalidad/especificidad (sin DB) + fallbacks
    const cleanedForTime = stripLeadGreetings(userInput);

    // 1) Intenta con extractor “lite”
    const entsEarly = extractEntitiesLite(cleanedForTime);

    try {
    } catch (e) {
      console.warn('⚠️ Rama específica falló; continuará pipeline normal:', e);
    }

    // 💡 Heurística específica: si el usuario pide precios + horarios, compón una respuesta combinada.
    const WANTS_SCHEDULE = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);
    const WANTS_PRICE = PRICE_REGEX.test(userInput);

    if (WANTS_PRICE && WANTS_SCHEDULE) {
      try {
        // Trae ambas FAQs
        const [faqPrecio, faqHorario] = await Promise.all([
          fetchFaqPrecio(tenant.id, canal),
          (async () => {
            const hitH = await getFaqByIntent(tenant.id, canal, 'horario');
            return hitH?.respuesta || null;
          })()
        ]);

        // Si no hay alguna de las dos, sigue el pipeline normal
        if (!faqPrecio || !faqHorario) {
          console.log('ℹ️ Combo precio+horario: falta alguna FAQ; sigo pipeline normal.');
        } else {
          // Construye "hechos" combinados y pásalos por tu promptBase para formato/tono/idioma
          const facts = [
            'INFO_PRECIOS:\n' + faqPrecio,
            '',
            'INFO_HORARIO:\n' + faqHorario
          ].join('\n');

          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
          const systemPrompt = [
            promptBase,
            '',
            `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
            `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas en prosa (sin bullets).`,
            'Usa solo los HECHOS provistos. Si hay enlaces oficiales, comparte solo 1 (el más pertinente).',
            'Incluye precios y horarios en un mismo mensaje, cerrando con un CTA breve.'
          ].join('\n');

          const userPrompt = [
            `MENSAJE_USUARIO:\n${userInput}`,
            '',
            `HECHOS AUTORIZADOS (usa ambos):\n${facts}`
          ].join('\n');

          let out = '';
          try {
            const completion = await openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 400,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            });
            out = (completion.choices[0]?.message?.content || '').trim();
            // Asegura idioma por si acaso
            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}
          } catch (e) {
            console.warn('⚠️ LLM combo precio+horario falló; uso facts crudos:', e);
            out = `${faqHorario}\n\n${faqPrecio}`;
          }

          // CTA consistente con el idioma
          const CTA_TXT =
            idiomaDestino === 'en'
              ? 'Is there anything else I can help you with?'
              : '¿Hay algo más en lo que te pueda ayudar?';

          out = `${out}\n\n${CTA_TXT}`;

          await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, out);
          alreadySent = true;

          await saveAssistantMessageAndEmit({
            tenantId: tenant.id,
            canal,
            fromNumber: fromNumber || 'anónimo',
            messageId,
            content: out,
          });

          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT DO NOTHING`,
            [tenant.id, canal, messageId]
          );

          // registra intención/seguimiento con "precio" como señal de venta
          try {
            const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
            const intFinal = normalizeIntentAlias(det?.intencion || 'precio');
            await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, det?.nivel_interes ?? 1, messageId);
            await scheduleFollowUp(intFinal, det?.nivel_interes ?? 1);
          } catch {}

          return; // ⬅️ ya respondimos el combo; salimos
        }
      } catch (e) {
        console.warn('⚠️ Heurística precio+horario falló; sigo pipeline normal:', e);
      }
    }

    // ─── INTENT MATCHER — RESPONDE ANTES DE FAQs/IA ───────────────────────
    try {
      // Comparamos en ES (igual que FAQs). Si el cliente no habla ES, traducimos su mensaje a ES.
      const textoParaMatch = (idiomaDestino !== 'es')
        ? await traducirMensaje(userInput, 'es').catch(() => userInput)
        : userInput;

      console.log('[INTENTS] match input=', textoParaMatch);

      const respIntent = await buscarRespuestaPorIntencion({
        tenant_id: tenant.id,
        canal: 'whatsapp',
        mensajeUsuario: textoParaMatch,
        idiomaDetectado: idiomaDestino,
        umbral: Math.max(INTENT_THRESHOLD, 0.70),
        filtrarPorIdioma: true
      });

      console.log('[INTENTS] result=', respIntent);

      // --- Anti-mismatch entre canónica y matcher ---
      const canonical = (INTENCION_FINAL_CANONICA || '').toLowerCase();
      const respIntentName = (respIntent?.intent || '').toLowerCase();

      const isCanonicalDirect = isDirectIntent(canonical, INTENTS_DIRECT);
      const askedPrice = PRICE_REGEX.test(userInput);

      // 1) Nunca aceptes 'precio' si NO lo pidió y la canónica es distinta
      if (respIntent && respIntentName === 'precio' && !askedPrice && canonical && canonical !== 'precio') {
        console.log('[GUARD-2] bloqueo precio: no fue solicitado y la canónica=', canonical, 'score=', respIntent?.score);
        // @ts-ignore
        respIntent.intent = null;
        // @ts-ignore
        respIntent.respuesta = null;
      }

      // 2) Si la canónica es DIRECTA y difiere del matcher, exige score alto (>= 0.85)
      if (respIntent && isCanonicalDirect && respIntentName && respIntentName !== canonical) {
        const score = Number(respIntent?.score ?? 0);
        if (score < MATCHER_MIN_OVERRIDE) {
          console.log('[GUARD-2] canónica directa vs matcher (score bajo). Mantengo canónica:', { canonical, respIntentName, score });
          // @ts-ignore
          respIntent.intent = null;
          // @ts-ignore
          respIntent.respuesta = null;
        }
      }

      if (respIntent?.respuesta) {
        let facts = respIntent.respuesta;

        // (Opcional) añade un breve resumen si el user pidió “info + precios”
        const askedInfo = /\b(info(?:rmación)?|information|clases?|servicios?)\b/i.test(userInput);
        const askedPrice2 = PRICE_REGEX.test(userInput);
        const askedSchedule = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);

        if ((askedInfo && askedPrice2) || (askedInfo && askedSchedule) || (askedPrice2 && askedSchedule)) {
          try {
            // agrega una FAQ adicional a los facts según falte precio u horario
            const needPrice = !/precio/i.test(respIntent?.intent || '') && askedPrice2;
            const needHorario = (respIntent?.intent || '') !== 'horario' && askedSchedule;

            if (needPrice) {
              const precio = await fetchFaqPrecio(tenant.id, canal);
              if (precio) facts = `${facts}\n\n${precio}`;
            }
            if (needHorario) {
              const hitHorario = await getFaqByIntent(tenant.id, canal, 'horario');
              if (hitHorario?.respuesta) facts = `${facts}\n\n${hitHorario.respuesta}`;
            }
          } catch {}
        }

        // 🔸 Siempre pasa por LLM con tu promptBase
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const systemPrompt = [
          promptBase,
          '',
          `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
          `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas en PROSA. **Sin Markdown, sin viñetas, sin encabezados/###**.`,
          'Usa únicamente los HECHOS; no inventes.',
          'Si hay ENLACES_OFICIALES en los hechos, comparte solo 1 (el más pertinente) tal cual.'
        ].join('\n');

        const userPrompt = [
          `MENSAJE_USUARIO:\n${userInput}`,
          '',
          `HECHOS (usa sólo esto como fuente):\n${facts}`,
          '',
          `IDIOMA_SALIDA: ${idiomaDestino}`
        ].join('\n');

        let out = facts;
        try {
          const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 400,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          });
          // registrar tokens
          const used = completion.usage?.total_tokens || 0;
          if (used > 0) {
            await pool.query(
              `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
              VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
              ON CONFLICT (tenant_id, canal, mes)
              DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
              [tenant.id, used]
            );
          }
          out = completion.choices[0]?.message?.content?.trim() || out;
        } catch (e) {
          console.warn('LLM compose falló; uso facts crudos:', e);
        }

        // Asegura idioma
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}

        // ⬇️ CTA por intención (matcher)
        const intentForCTA = pickIntentForCTA({
          matcher: respIntent?.intent || null,
          canonical: INTENCION_FINAL_CANONICA || null
        });
        const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
        const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
        const outWithCTA = appendCTAWithCap(out, ctaX);

        await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, outWithCTA);
        alreadySent = true;

        await saveAssistantMessageAndEmit({
          tenantId: tenant.id,
          canal,
          fromNumber: fromNumber || 'anónimo',
          messageId,
          content: outWithCTA,
        });

        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [tenant.id, canal, messageId]
        );

        // 🔔 Registrar venta si aplica + follow-up
        try {
          let intFinal = (respIntent.intent || '').toLowerCase().trim();
          if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
          intFinal = normalizeIntentAlias(intFinal);
          const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
          const nivel = det?.nivel_interes ?? 1;
          await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, nivel, messageId);
          await scheduleFollowUp(intFinal, nivel);
        } catch (e) {
          console.warn('⚠️ No se pudo programar follow-up post-intent (WA):', e);
        }

        return; // <- sales registrado; salir
      }

    } catch (e) {
      console.warn('⚠️ Matcher de intenciones no coincidió o falló:', e);
    }
  

  // 🔎 Interceptor canal-agnóstico (recomendación principiantes)
  const interceptado = await runBeginnerRecoInterceptor({
    tenantId: tenant.id,
    canal: 'whatsapp',
    fromNumber,
    userInput,
    idiomaDestino,
    intencionParaFaq,
    promptBase,
    enviarFn: enviarWhatsApp,
  });

  if (interceptado) {
    console.log('✅ Interceptor principiantes respondió en WhatsApp.');

    try {
      let intFinal = (intencionParaFaq || '').toLowerCase().trim();
      if (!intFinal) {
        const detTmp = await detectarIntencion(userInput, tenant.id, 'whatsapp');
        intFinal = normalizeIntentAlias((detTmp?.intencion || '').toLowerCase());
      }
      const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      const nivel = det?.nivel_interes ?? 1;

      // registrar venta si aplica + follow up
      await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, nivel, messageId);
      await scheduleFollowUp(intFinal, nivel);
    } catch (e) {
      console.warn('⚠️ No se pudo programar follow-up tras interceptor (WA):', e);
    }  
    return; // evita FAQ genérica
  }

  // [REPLACE] lookup robusto
  let respuestaDesdeFaq: string | null = null;

  console.log('[FAQ-LOOKUP] tenant=', tenant.id, 'canal=', canal, 'intent=', intencionParaFaq);

  const hit = await getFaqByIntent(tenant.id, canal, intencionParaFaq);
  if (hit) {
    console.log('📚 FAQ encontrada →', hit.id, hit.intencion, 'canal:', hit.canal);
    respuestaDesdeFaq = hit.respuesta;
  } else {
    console.log('🚫 FAQ NO encontrada para intent:', intencionParaFaq);
  }

  if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
    if (intencionParaFaq === 'precio') {
      respuestaDesdeFaq = await fetchFaqPrecio(tenant.id, canal);
    } else {
      const hit2 = await getFaqByIntent(tenant.id, canal, intencionParaFaq);
      if (hit2) {
        respuestaDesdeFaq = hit2.respuesta;
        console.log('📚 FAQ encontrada para intención:', hit2.intencion, 'canal:', hit2.canal);
      }
    }
  }

  if (respuestaDesdeFaq) {
    // 1) Construye los HECHOS desde la FAQ oficial
    let facts = respuestaDesdeFaq;

    // 2) Pásalo por OpenAI con tu promptBase (igual que en la rama de intents)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const systemPrompt = [
      promptBase,
      '',
      `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
      `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas, claro y con bullets si hace falta.`,
      'Usa SOLO la información del prompt.',
      'SI HAY PRECIOS EN EL PROMPT/HECHOS, MENCIONA al menos 1-3 planes con su monto (resumen corto).',
      'Si hay ENLACES_OFICIALES en los prompt/hechos, comparte solo 1 (el más pertinente) tal cual.',
      'Si el usuario preguntó varias cosas, cúbrelas en UN solo mensaje.'
    ].join('\n');

    const userPrompt = [
      `MENSAJE_USUARIO:\n${userInput}`,
      '',
      `HECHOS (fuente autorizada):\n${facts}`
    ].join('\n');

    let out = facts; // fallback si el LLM falla
    let tokens = 0;
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
      });
      // registrar tokens
      const used = completion.usage?.total_tokens || 0;
      if (used > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
          VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, used]
        );
      }
      out = completion.choices[0]?.message?.content?.trim() || out;
      tokens = completion.usage?.total_tokens || 0;
    } catch (e) {
      console.warn('LLM compose (FAQ) falló; envío facts crudos:', e);
    }

    // 3) Asegura idioma de salida
    try {
      const langOut = await detectarIdioma(out);
      if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
        out = await traducirMensaje(out, idiomaDestino);
      }
    } catch {}

    // ⬇️ CTA por intención (FAQ directa)
    const intentForCTA = pickIntentForCTA({
      canonical: INTENCION_FINAL_CANONICA || null,
      fallback: intencionParaFaq || null
    });
    const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
    const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
    const outWithCTA = appendCTAWithCap(out, ctaX);

    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, outWithCTA);
    alreadySent = true;

    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: outWithCTA,
    });

    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.id, canal, messageId]
    );

    // 🔔 Registrar venta si aplica + follow-up
    try {
      const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      const nivelFaq = det?.nivel_interes ?? 1;
      const intFinal = (INTENCION_FINAL_CANONICA || '').toLowerCase();
      await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, nivelFaq, messageId);
      const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
      if (nivelFaq >= 3 || intencionesFollowUp.includes(intFinal)) {
        await scheduleFollowUp(intFinal, nivelFaq);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo programar follow-up tras FAQ (WA):', e);
    }

    return; // 🔚 importante para no caer a los bloques de abajo
  }

  // Si NO hubo FAQ directa → similaridad
  {
    const mensajeTraducido = (idiomaDestino !== 'es')
      ? await traducirMensaje(mensajeUsuario, 'es')
      : mensajeUsuario;

    respuesta = await buscarRespuestaSimilitudFaqsTraducido(
      faqs,
      mensajeTraducido,
      idiomaDestino
    );
  }

  // 🔒 Protección adicional: si ya respondió con FAQ oficial, no continuar
  // (por seguridad; normalmente ya retornamos antes)
  // if (respuestaDesdeFaq) return;

  // ⛔ No generes sugeridas si el mensaje NO tiene letras o es muy corto
  const hasLetters = /\p{L}/u.test(userInput);
  if (!hasLetters || normalizarTexto(userInput).length < 4) {
    console.log('🧯 No se genera sugerida (sin letras o texto muy corto).');
    // aun así responde si hay "respuesta" calculada
    if (respuesta) {
      let intentForCTA: string | null = null;
      try {
        const detEnd = await detectarIntencion(userInput, tenant.id, 'whatsapp');
        intentForCTA = pickIntentForCTA({
          canonical: INTENCION_FINAL_CANONICA || null,
          fallback: normalizeIntentAlias((detEnd?.intencion || '').toLowerCase())
        });
      } catch {}

      const cta5raw = intentForCTA ? await getTenantCTA(tenant.id, intentForCTA, canal) : null;
      const cta5    = await translateCTAIfNeeded(cta5raw, idiomaDestino);

      const withDefaultCta = cta5 ? respuesta : `${respuesta}\n\n${CTA_TXT}`;
      const respuestaWithCTA = appendCTAWithCap(withDefaultCta, cta5);

      await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, respuestaWithCTA);

      await saveAssistantMessageAndEmit({
        tenantId: tenant.id,
        canal,
        fromNumber: fromNumber || 'anónimo',
        messageId,
        content: respuestaWithCTA,
      });

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [tenant.id, canal, messageId]
      );
    }
    // registra venta si aplica
    try {
      const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      const intFinal = normalizeIntentAlias(det?.intencion || '');
      await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, det?.nivel_interes ?? 1, messageId);
    } catch {}
    return;
  }

  // 🧠 Si no hay respuesta aún, generar con OpenAI y registrar como FAQ sugerida
  if (!respuestaDesdeFaq && !respuesta) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: promptBase },
        { role: 'user', content: userInput },
      ],
    });

    // registrar tokens
    const used = completion.usage?.total_tokens || 0;
    if (used > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
        VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenant.id, used]
      );
    }
    respuesta = completion.choices[0]?.message?.content?.trim()
            || getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

    const respuestaGenerada = respuesta;

    // 🌐 Asegurar idioma del cliente
    try {
      const idiomaRespuesta = await detectarIdioma(respuesta);
      if (idiomaRespuesta && idiomaRespuesta !== 'zxx' &&
          idiomaRespuesta !== idiomaDestino) {
        respuesta = await traducirMensaje(respuesta, idiomaDestino);
      }

    } catch (e) {
      console.warn('No se pudo traducir la respuesta de OpenAI:', e);
    }

    const respuestaGeneradaLimpia = respuesta;
    const preguntaNormalizada = normalizarTexto(userInput);
    const respuestaNormalizada = respuestaGeneradaLimpia.trim();

    let sugeridasExistentes: any[] = [];
    try {
      const sugeridasRes = await pool.query(
        'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
        [tenant.id, canal]
      );
      sugeridasExistentes = sugeridasRes.rows || [];
    } catch (error) {
      console.error('⚠️ Error consultando FAQ sugeridas:', error);
    }

    // Verificación de duplicados
    const yaExisteSugerida = yaExisteComoFaqSugerida(
      userInput,
      respuestaGenerada,
      sugeridasExistentes
    );

    const yaExisteAprobada = yaExisteComoFaqAprobada(
      userInput,
      respuestaGenerada,
      faqs
    );

    if (yaExisteSugerida || yaExisteAprobada) {
      if (yaExisteSugerida) {
        await pool.query(
          `UPDATE faq_sugeridas 
           SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
           WHERE id = $1`,
          [yaExisteSugerida.id]
        );
        console.log(`⚠️ Pregunta similar ya sugerida (ID: ${yaExisteSugerida.id})`);
      } else {
        console.log(`⚠️ Pregunta ya registrada como FAQ oficial.`);
      }
    } else {
      // 🧠 Detectar intención para evitar duplicados semánticos
      const textoTraducidoParaGuardar = idioma !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

      // Normaliza "duda" a sub-slug antes de guardar la sugerida
      const { intencion: intencionDetectadaParaGuardar } =
      await detectarIntencion(textoTraducidoParaGuardar, tenant.id, 'whatsapp');

      let intencionFinal = intencionDetectadaParaGuardar.trim().toLowerCase();
      if (intencionFinal === 'duda') {
        intencionFinal = buildDudaSlug(userInput);
      }
      intencionFinal = normalizeIntentAlias(intencionFinal);

      const { rows: sugeridasConIntencion } = await pool.query(
      `SELECT intencion FROM faq_sugeridas 
      WHERE tenant_id = $1 AND canal = $2 AND procesada = false`,
      [tenant.id, canal]
      );

      const { rows: faqsOficiales } = await pool.query(
      `SELECT intencion FROM faqs 
      WHERE tenant_id = $1 AND canal = $2`,
      [tenant.id, canal]
      );

      // Compara intención detectada con las oficiales (aplica unicidad solo a INTENT_UNIQUE)
      const enforzaUnicidad = INTENT_UNIQUE.has(intencionFinal);

      const yaExisteIntencionOficial = faqsOficiales.some(faq =>
        (faq.intencion || '').trim().toLowerCase() === intencionFinal
      );

      if (enforzaUnicidad && yaExisteIntencionOficial) {
        console.log(`⚠️ Ya existe una FAQ oficial con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
      } else {
        const yaExisteIntencion = sugeridasConIntencion.some(faq =>
          (faq.intencion || '').trim().toLowerCase() === intencionFinal
        );

        if (enforzaUnicidad && yaExisteIntencion) {
          console.log(`⚠️ Ya existe una FAQ sugerida con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
          // 🚫 No hacer return aquí
        } else {
          // ✅ Insertar la sugerencia
          await pool.query(
            `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
            VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
            [tenant.id, canal, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
          );
          console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
        }
      }
    }

    const tokensConsumidos = completion.usage?.total_tokens || 0;
    if (tokensConsumidos > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenant.id, tokensConsumidos]
      );
    }    
  }  

  // Insertar mensaje bot (esto no suma a uso)
  if (!alreadySent) {
    await saveAssistantMessageAndEmit({
      tenantId: tenant.id,
      canal,
      fromNumber: fromNumber || 'anónimo',
      messageId,
      content: respuesta,
    });
  }

  // ⬇️ CTA por intención (fallback final/generativa)
  let intentForCTA: string | null = null;
  try {
    const detEnd = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    intentForCTA = pickIntentForCTA({
      canonical: INTENCION_FINAL_CANONICA || null,
      fallback: normalizeIntentAlias((detEnd?.intencion || '').toLowerCase())
    });
  } catch {}

  const intentForCTANorm = intentForCTA ? normalizeIntentAlias(intentForCTA) : null;
  const cta5raw = await pickCTA(tenant, intentForCTANorm, canal);
  const cta5    = await translateCTAIfNeeded(cta5raw, idiomaDestino);

  // Si por alguna razón nadie llenó "respuesta", usa la bienvenida del tenant
  if (!respuesta) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
  }

  let respuestaFinal: string;

  if (isSmallTalkOrCourtesy) {
    // 🙅‍♂️ Si el usuario solo dijo "hola", "buenos días", "thanks", etc. → SIN CTA
    respuestaFinal = respuesta;
  } else {
    const withDefaultCta = cta5 ? respuesta : `${respuesta}\n\n${CTA_TXT}`;
    respuestaFinal = appendCTAWithCap(withDefaultCta, cta5);
  }

  if (!alreadySent) {
    await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, respuestaFinal);
    console.log("📬 Respuesta enviada vía Twilio:", respuestaFinal);
  }

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [tenant.id, canal, messageId]
  );  

  try {
    const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    const nivel_interes = det?.nivel_interes ?? 1;
    let intFinal = normalizeIntentAlias((det?.intencion || '').toLowerCase());

    const textoNormalizado = userInput.trim().toLowerCase();
    console.log(`🔎 Intención (final) = ${intFinal}, Nivel de interés: ${nivel_interes}`);

    // 🛑 No registrar si es saludo puro
    const saludos = ["hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hello", "hi", "hey"];
    if (saludos.includes(textoNormalizado)) {
      console.log("⚠️ Mensaje ignorado por ser saludo.");
      return;
    }

    // Segmentación con intención final
    const intencionesCliente = [
      "comprar", "compra", "pagar", "agendar", "reservar", "confirmar",
      "interes_clases", "precio"
    ];
    if (intencionesCliente.some(p => intFinal.includes(p))) {
      await pool.query(
        `UPDATE clientes
            SET segmento = 'cliente'
          WHERE tenant_id = $1
            AND contacto = $2
            AND (segmento = 'lead' OR segmento IS NULL)`,
        [tenant.id, fromNumber]
      );
    }

    // 🔥 Registrar en sales_intelligence **solo si es venta**
    await recordSalesIntent(tenant.id, fromNumber, canal, userInput, intFinal, nivel_interes, messageId);

    // 🚀 Follow-up con intención final
    if (nivel_interes >= 3 || ["interes_clases","reservar","precio","comprar","horario"].includes(intFinal)) {
      await scheduleFollowUp(intFinal, nivel_interes);
    }
    
  } catch (err) {
    console.error("⚠️ Error en inteligencia de ventas o seguimiento:", err);
  }   
}
