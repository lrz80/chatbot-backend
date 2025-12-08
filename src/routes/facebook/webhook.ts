// src/routes/facebook/webhook.ts

import express from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buildDudaSlug, normalizeIntentAlias, isDirectIntent } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { runBeginnerRecoInterceptor } from '../../lib/recoPrincipiantes/interceptor';
import { buscarRespuestaPorIntencion } from '../../services/intent-matcher';
import { enviarMensajePorPartes } from '../../lib/enviarMensajePorPartes';
import { extractEntitiesLite } from '../../utils/extractEntitiesLite';
import { getFaqByIntent } from '../../utils/getFaqByIntent';
import { answerMultiIntent, detectTopIntents } from '../../utils/multiIntent';
import { tidyMultiAnswer } from '../../utils/tidyMultiAnswer';
import { Router, Request, Response } from 'express';
import { buscarRespuestaSimilitudFaqsTraducido } from '../../lib/respuestasTraducidas';
import type { Canal } from '../../lib/detectarIntencion';
import { requireChannel } from "../../middleware/requireChannel";
import { canUseChannel } from "../../lib/features";
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { incrementarUsoPorCanal } from '../../lib/incrementUsage';

type CanalEnvio = 'facebook' | 'instagram';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const GLOBAL_ID = process.env.GLOBAL_CHANNEL_TENANT_ID
  || '00000000-0000-0000-0000-000000000001'; // fallback seguro
// ———————————————————————————————————————————————————————————
// Config comunes (idénticos a WhatsApp)
// ———————————————————————————————————————————————————————————
const PRICE_REGEX = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
const MATCHER_MIN_OVERRIDE = 0.85;

const INTENT_THRESHOLD = Math.min(
  0.95,
  Math.max(0.30, Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55))
);

const INTENTS_DIRECT = new Set([
  'interes_clases','precio','horario','ubicacion','reservar','comprar','confirmar','clases_online'
]);

const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// Normalizadores de idioma
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base;
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  return Number.isFinite(m) && m > 0 ? m : fallbackMin;
}

// Idioma persistente por contacto
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
      DO UPDATE SET idioma = EXCLUDED.idioma, updated_at = now()`,
      [tenantId, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

function pickIntentForCTA(
  opts: {
    canonical?: string | null;     // INTENCION_FINAL_CANONICA
    matcher?: string | null;       // intención que venga del intent-matcher
    firstOfTop?: string | null;    // top[0]?.intent en multi-intent
    fallback?: string | null;      // intenCanon u otras
    prefer?: string | null;        // fuerza algo (ej. 'precio' si el user pidió precios)
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

const MAX_WHATSAPP_LINES = 16; // podemos reutilizarlo también para Meta

function appendCTAWithCap(
  text: string,
  cta: { cta_text: string; cta_url: string } | null
) {
  if (!cta) return text;
  const extra = `\n\n${cta.cta_text}: ${cta.cta_url}`;
  const lines = text.split('\n'); // no filtramos vacías
  const limit = Math.max(0, MAX_WHATSAPP_LINES - 2); // deja 2 líneas para CTA
  if (lines.length > limit) {
    return lines.slice(0, limit).join('\n') + extra;
  }
  return text + extra;
}

async function translateCTAIfNeeded(
  cta: { cta_text: string; cta_url: string } | null,
  idiomaDestino: 'es'|'en'
) {
  if (!cta) return null;
  let txt = (cta.cta_text || '').trim();
  try {
    const lang = await detectarIdioma(txt).catch(() => null);
    if (lang && lang !== 'zxx' && ((idiomaDestino === 'en' && !/^en/i.test(lang)) ||
                                   (idiomaDestino === 'es' && !/^es/i.test(lang)))) {
      txt = await traducirMensaje(txt, idiomaDestino);
    } else if (!lang) {
      txt = await traducirMensaje(txt, idiomaDestino);
    }
  } catch {}
  return { cta_text: txt, cta_url: cta.cta_url };
}

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

// CTA “global” guardada en las columnas del tenant (no en tenant_ctas)
function getGlobalCTAFromTenant(tenant: any) {
  const t = (tenant?.cta_text || '').trim();
  const u = (tenant?.cta_url  || '').trim();
  if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
  return null;
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

// Selecciona CTA por intención; si no hay, usa CTA global del tenant
async function pickCTA(tenant: any, intent: string | null, channel: string) {
  if (intent) {
    const byIntent = await getTenantCTA(tenant.id, intent, channel);
    if (byIntent) return byIntent;
  }
  // fallback opcional desde columnas del tenant (si las usas)
  const global = getGlobalCTAFromTenant(tenant);
  if (global) return global;
  return null;
}

async function isMetaChannelOpen(tenantId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT meta_enabled, paused_until_meta
       FROM channel_settings
      WHERE tenant_id = $1 OR tenant_id = $2
      ORDER BY CASE WHEN tenant_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, GLOBAL_ID]
  );
  const row = rows[0];
  if (!row) return true;                   // sin fila => abierto por defecto
  const enabled = row.meta_enabled !== false; // null/true => abierto
  const paused = row.paused_until_meta
    ? new Date(row.paused_until_meta).getTime() > Date.now()
    : false;
  return enabled && !paused;
}

// Evita loops por duplicados Meta mid
const mensajesProcesados = new Set<string>();

// ———————————————————————————————————————————————————————————
// Verificación GET (Meta)
// ———————————————————————————————————————————————————————————
router.get('/api/facebook/webhook', requireChannel("meta"), (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook de Facebook verificado');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ———————————————————————————————————————————————————————————
// POST: Meta (Facebook / Instagram) — igual a WhatsApp en flujo
// ———————————————————————————————————————————————————————————
router.post('/api/facebook/webhook', async (req, res) => {
  console.log("🌐 [META WEBHOOK] POST recibido:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return;

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging) {
        if (!messagingEvent.message) continue;
        if (messagingEvent.message.is_echo === true) continue;
        if (!messagingEvent.message.text) continue;

        const senderId = messagingEvent.sender.id;
        const messageId = messagingEvent.message.mid;
        const userInput = messagingEvent.message.text || '';
        const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

        // dedupe por mid (memoria)
        if (mensajesProcesados.has(messageId)) continue;
        mensajesProcesados.add(messageId);
        setTimeout(() => mensajesProcesados.delete(messageId), 60000);

        // Unir tenants + meta-configs (id x pageId o ig id)
        const { rows } = await pool.query(
          `SELECT t.*
                 , m.prompt_meta
                 , m.bienvenida_meta
                 , t.facebook_access_token
            FROM tenants t
       LEFT JOIN meta_configs m ON t.id = m.tenant_id
           WHERE t.facebook_page_id = $1 OR t.instagram_page_id = $1
           LIMIT 1`,
          [pageId]
        );
        if (!rows.length) continue;

        const tenant = rows[0];
        const tenantId: string = tenant.id;

        const isInstagram = tenant.instagram_page_id && tenant.instagram_page_id === pageId;
        const canalEnvio: CanalEnvio = isInstagram ? 'instagram' : 'facebook';
        const canalContenido = 'meta'; // FAQs se guardan como 'meta'
        const accessToken = tenant.facebook_access_token as string;


        // 🚧 Gate unificado por plan/pausa/mantenimiento
        try {
          const gate = await canUseChannel(tenantId, "meta");
          if (!gate.plan_enabled) {
            console.log("🛑 META bloqueado por plan; no se responderá.", { tenantId });
            continue; // no respondas nada (ya hiciste 200 arriba)
          }
          if (gate.reason === "paused") {
            console.log("⏸️ META en pausa hasta", gate.paused_until, "; no se responderá.");
            continue;
          }
        } catch (e) {
          console.warn("Guard META: error calculando canUseChannel; bloqueo por seguridad:", e);
          continue;
        }

        // helper envío Meta (chunked)
        const sendMeta = async (text: string) => {
          await enviarMensajePorPartes({
            respuesta: text,
            senderId,
            tenantId,
            canal: canalEnvio,
            messageId,
            accessToken,
          });
        };

        // ✅ NUEVO: versión que envía y cuenta uso_mensual SOLO en respuestas del bot
        const sendMetaContabilizando = async (text: string) => {
          await sendMeta(text);
          await incrementarUsoPorCanal(tenantId, canalEnvio); // 'facebook' o 'instagram'
        };

        // Para los helpers que ya usan enviarMetaSeguro (recoPrincipiantes)
        const enviarMetaSeguro = async (_to: string, text: string, _tenantId: string) =>
          sendMetaContabilizando(text);

        // Idempotencia: si ya está en messages, avanzar
        const existingMsg = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
          [tenantId, messageId]
        );
        if (existingMsg.rows.length > 0) continue;

        // 🌐 Idioma destino (mismo que WA) — MOVER AQUÍ
        const tenantBase: 'es'|'en' = normalizeLang(tenant?.idioma || 'es');
        let idiomaDestino: 'es'|'en';
        if (isNumericOnly) {
          idiomaDestino = await getIdiomaClienteDB(tenantId, senderId, tenantBase);
        } else {
          let detectado: string | null = null;
          try { detectado = normLang(await detectarIdioma(userInput)); } catch {}
          const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);
          await upsertIdiomaClienteDB(tenantId, senderId, normalizado);
          idiomaDestino = normalizado;
        }

        // 🛡️ Anti-phishing reutilizable (EARLY EXIT)
        const handledPhishing = await antiPhishingGuard({
          pool,
          tenantId,
          channel: canalEnvio,
          senderId,
          messageId,
          userInput,
          idiomaDestino,
          send: async (text) => sendMetaContabilizando(text),
        });

        if (handledPhishing) {
          // Ya se respondió y registró; NO sigas con FAQs/IA/etc.
          continue;
        }

        // 🧹 Cancela follow-ups pendientes de este contacto
        try {
          await pool.query(
            `DELETE FROM mensajes_programados
              WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
            [tenantId, canalEnvio, senderId]
          );
        } catch {}

        // Guardar mensaje user (una vez)
        try {
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, userInput, canalEnvio, senderId || 'anónimo', messageId]
          );
        } catch {}

                // Helper para quitar saludos al inicio (igual que en WhatsApp)
        function stripLeadGreetings(t: string) {
          return t
            .replace(/^\s*(hola+[\s!.,]*)?/i, '')
            .replace(/^\s*(saludos+[\s!.,]*)?/i, '')
            .replace(/^\s*(hello+|hi+|hey+)[\s!.,]*/i, '')
            .trim();
        }

        // Bloqueo por membresía (igual WA)
        const estaActiva = tenant.membresia_activa === true || tenant.membresia_activa === 'true' || tenant.membresia_activa === 1;
        if (!estaActiva) {
          console.log(`🚫 Tenant ${tenantId} sin membresía activa. No se responderá en Meta.`);
          continue;
        }

        // Prompt base y bienvenida por CANAL (prioriza meta_configs)
        const promptBase =
          (tenant.prompt_meta && String(tenant.prompt_meta).trim())
          || getPromptPorCanal('meta', tenant, idiomaDestino);

        const bienvenida =
          (tenant.bienvenida_meta && String(tenant.bienvenida_meta).trim())
          || getBienvenidaPorCanal('meta', tenant, idiomaDestino);

        // ============================================
        // 🧩 CASO ESPECIAL: usuario pide "más info"
        // ============================================
        const cleanedForInfo = stripLeadGreetings(userInput);
        const cleanedNorm    = normalizarTexto(cleanedForInfo);

        const wantsMoreInfoEn =
          /\b(need\s+more\s+in(?:f|fo|formation)|i\s+want\s+more\s+in(?:f|fo|formation)|more\s+in(?:f|fo|formation))\b/i
            .test(cleanedForInfo);

        const wantsMoreInfoEs =
          /\b((necesito|quiero)\s+mas\s+in(?:f|fo|formacion)|mas\s+info|mas\s+informacion)\b/i
            .test(cleanedNorm);

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

        const trailing = /(pls?|please|por\s*fa(vor)?)/i;

        const msgLower = cleanedNorm.toLowerCase();
        const shortInfoOnly =
          wantsMoreInfoDirect.some(k => msgLower.includes(k)) ||
          trailing.test(msgLower);

        const wantsMoreInfo = wantsMoreInfoEn || wantsMoreInfoEs || shortInfoOnly;

        if (wantsMoreInfo) {
          const startsWithGreeting = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?|buenas|buenos\s+(dias|días))/i
            .test(userInput);

          let reply: string;

          try {
            const systemPrompt = [
              promptBase,
              '',
              `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
              'Formato Meta: mensajes MUY CORTOS (2–3 frases, máx. ~6 líneas), sin párrafos largos.',
              'No uses viñetas, listas ni encabezados. Solo texto corrido, claro y directo.',
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
- who it is for.
Do NOT include prices, discounts, trial days, email addresses, websites or any links.
Avoid marketing or hype. Be simple and clear.
Avoid repeating these instructions or explaining what you are doing; just answer as if you were the business.
End with this exact question in English:
"What would you like to know more about? Our services, prices, or something else?"`
                : `El usuario está pidiendo información general (por ejemplo "quiero más info", "necesito más información", "más info pls").
Usando SOLO la información del negocio en el prompt, escribe una explicación MUY CORTA (2-3 frases) que diga:
- qué hace este negocio,
- para quién es.
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
                { role: 'user',   content: userPromptLLM },
              ],
            });

            reply =
              completion.choices[0]?.message?.content?.trim() ??
              (idiomaDestino === 'en'
                ? 'What would you like to know more about? Our services, prices, schedule, or something else?'
                : '¿Sobre qué te gustaría saber más? ¿Servicios, precios, horarios u otra cosa?');

            const used = completion.usage?.total_tokens || 0;
            if (used > 0) {
              await pool.query(
                `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                 VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                 ON CONFLICT (tenant_id, canal, mes)
                 DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                [tenantId, used]
              );
            }
          } catch (e) {
            console.warn('⚠️ LLM (more info META) falló; uso fallback fijo:', e);
            reply =
              idiomaDestino === 'en'
                ? 'What would you like to know more about? Our services, prices, schedule, or something else?'
                : '¿Sobre qué te gustaría saber más? ¿Servicios, precios, horarios u otra cosa?';
          }

          if (startsWithGreeting) {
            reply = `${bienvenida}\n\n${reply}`;
          }

          await sendMetaContabilizando(reply);

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, reply, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );

          // Registrar intención de venta y follow-up igual que en WA
          try {
            await scheduleFollowUp('pedir_info', 2);
          } catch (e) {
            console.warn('⚠️ No se pudo registrar sales_intelligence (more info META):', e);
          }

          continue; // ⬅️ ya respondimos "más info"
        }

        // ============================================
        // 🧩 CASO ESPECIAL: DEMOSTRACIÓN / DEMO
        // ============================================
        const wantsDemo =
          /\b(demuéstramelo|demuestrame|demuestrame|hazme una demostracion|hazme un demo|prueba real|ejemplo real|muestrame como funciona|muestrame como responde|show me|prove it|give me a demo)\b/i
            .test(cleanedNorm);

        if (wantsDemo) {
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
              ? `${bienvenida}\n\n${demoTextEn}`
              : `${bienvenida}\n\n${demoTextEs}`;

          await sendMetaContabilizando(reply);

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, reply, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );

          try {
            await scheduleFollowUp('demo', 2);
          } catch (e) {
            console.warn('⚠️ No se pudo registrar sales_intelligence (demo META):', e);
          }

          continue; // ⬅️ ya respondimos demo
        }

        // —————————————————————————
        // FAST-PATH MULTI-INTENCIÓN (META con CTA)
        // —————————————————————————
        try {
          const top = await detectTopIntents(userInput, tenantId, canalContenido as any, 3);

          // 👇 Nueva validación para evitar errores cuando top viene null/undefined
          if (!top || !Array.isArray(top) || top.length === 0) {
            console.log('ℹ️ [META] detectTopIntents sin resultados; sigo pipeline normal.');
          } else {
            const hasPrecio = top.some(t => t.intent === 'precio');
            const hasInfo   = top.some(
              t => t.intent === 'interes_clases' || t.intent === 'pedir_info'
            );
            const multiAsk  = top.length >= 2 || (hasPrecio && hasInfo);

            if (multiAsk) {
              const multi = await answerMultiIntent({
                tenantId,
                canal: canalContenido as any,
                userText: userInput,
                idiomaDestino,
                promptBase
              });

              if (multi?.text) {
                let multiText = multi.text || '';

                // ¿Pidió horarios / precios explícitamente?
                const askedSchedule = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i
                  .test(userInput);
                const askedPrice    = PRICE_REGEX.test(userInput);

                const hasPriceInText    = /\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(multiText);
                const hasScheduleInText = /\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i.test(multiText);

                // ⬇️ PREPEND precios si el usuario los pide y el texto no los trae
                if (askedPrice && !hasPriceInText) {
                  try {
                    const precioFAQ = await fetchFaqPrecio(tenantId, canalContenido as any);
                    if (precioFAQ?.trim()) {
                      multiText = [precioFAQ.trim(), '', multiText.trim()].join('\n\n');
                    }
                  } catch (e) {
                    console.warn('⚠️ [META] No se pudo anexar FAQ precios en MULTI:', e);
                  }
                }

                // ⬇️ APPEND horario si el usuario lo pide y el texto no lo trae
                if (askedSchedule && !hasScheduleInText) {
                  try {
                    const hitH = await getFaqByIntent(tenantId, canalContenido as any, 'horario');
                    if (hitH?.respuesta?.trim()) {
                      multiText = [multiText.trim(), '', hitH.respuesta.trim()].join('\n\n');
                    }
                  } catch (e) {
                    console.warn('⚠️ [META] No se pudo anexar FAQ horario en MULTI:', e);
                  }
                }

                // Asegura idioma de salida
                try {
                  const langOut = await detectarIdioma(multiText);
                  if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                    multiText = await traducirMensaje(multiText, idiomaDestino);
                  }
                } catch {}

                // CTA de texto base (igual que en WhatsApp)
                const CTA_TXT =
                  idiomaDestino === 'en'
                    ? 'Is there anything else I can help you with?'
                    : '¿Hay algo más en lo que te pueda ayudar?';

                const out = tidyMultiAnswer(multiText, {
                  maxLines: MAX_WHATSAPP_LINES - 2, // deja espacio para CTA con link
                  freezeUrls: true,
                  cta: CTA_TXT
                });

                // ⬇️ CTA por intención (multi-intent)
                const prefer = askedPrice ? 'precio' : (askedSchedule ? 'horario' : null);
                const intentForCTA = pickIntentForCTA({
                  firstOfTop: top?.[0]?.intent || null,
                  prefer
                });

                const ctaXraw = await pickCTA(tenant, intentForCTA, canalEnvio);
                const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
                const outWithCTA = appendCTAWithCap(out, ctaX);

                // Enviar a Facebook / Instagram contabilizando uso (igual que antes)
                await sendMetaContabilizando(outWithCTA);

                // Guardar mensaje assistant en DB con el TEXTO FINAL (con CTA)
                await pool.query(
                  `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                  VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                  ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                  [tenantId, outWithCTA, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
                );

                await pool.query(
                  `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
                  VALUES ($1, $2, $3, NOW())
                  ON CONFLICT DO NOTHING`,
                  [tenantId, canalEnvio, messageId]
                );

                // Follow-up igual que antes
                await scheduleFollowUp('interes_clases', 3);

                // ⬅️ salir fast-path
                continue;
              }
            }
          }
        } catch (e) {
          console.warn('⚠️ Multi-intent fast-path falló; sigo pipeline normal:', e);
        }

       // Follow-up scheduler + registro de intención (canónica)
      async function scheduleFollowUp(intFinal: string, nivel: number) {
        try {
          // 👇 Forzamos canónico aquí
          const canon = normalizeIntentAlias((intFinal || '').toLowerCase().trim()) || '';
          // fallback específico para precios si tu normalizador no lo convierte
          const canonFinal = PRICE_REGEX.test(canon) || PRICE_REGEX.test(intFinal) ? 'precio' : canon;
          if (!canonFinal) return;

          await pool.query(
            `INSERT INTO sales_intelligence
              (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
            [tenantId, senderId, canalEnvio, userInput, canonFinal, Math.max(1, Number(nivel)||1), messageId]
          );
          console.log('🧠 Intent registrada (META)', {
            tenantId, contacto: senderId, canal: canalEnvio, intencion: canonFinal, nivel
          });

          const intencionesFollowUp = ["interes_clases","reservar","precio","comprar","horario"];
          const condition = (nivel >= 3) || intencionesFollowUp.includes(canonFinal);
          if (!condition) return;

          const { rows: cfgRows } = await pool.query(
            `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
            [tenantId]
          );
          const cfg = cfgRows[0];
          if (!cfg) return;

          // Mensaje por defecto + variantes por intención
          let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
          if (canon === "precio" && cfg.mensaje_precio) msg = cfg.mensaje_precio;
          else if ((canon === "reservar" || canon === "comprar") && cfg.mensaje_agendar) msg = cfg.mensaje_agendar;
          else if (canon === "ubicacion" && cfg.mensaje_ubicacion) msg = cfg.mensaje_ubicacion;

          // Asegura idioma de salida consistente
          try {
            const lang = await detectarIdioma(msg);
            if (lang && lang !== 'zxx' && lang !== idiomaDestino) {
              msg = await traducirMensaje(msg, idiomaDestino);
            }
          } catch {}

          // 4) Limpia duplicados pendientes para este contacto
          await pool.query(
            `DELETE FROM mensajes_programados
              WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
            [tenantId, canalEnvio, senderId]
          );

          // 5) Programa el follow-up
          const delayMin = getConfigDelayMinutes(cfg, 60);
          const fechaEnvio = new Date();
          fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

          const { rows } = await pool.query(
            `INSERT INTO mensajes_programados
              (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
            VALUES ($1, $2, $3, $4, $5, false)
            RETURNING id`,
            [tenantId, canalEnvio, senderId, msg, fechaEnvio]
          );

          console.log('📅 Follow-up programado (META)', {
            id: rows[0]?.id, tenantId, contacto: senderId, delayMin, fechaEnvio: fechaEnvio.toISOString()
          });
        } catch (e) {
          console.warn('⚠️ No se pudo programar follow-up o registrar intención (META):', e);
        }
      }

        // No empujar CTA si el mensaje es solo saludo / gracias / ok (small talk)
        const isSmallTalkOrCourtesy =
          /^(hola|hello|hi|hey|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|thank\s+you|ok|okay|vale|perfecto)\b/i
            .test(userInput.trim());

        // Saludos/agradecimientos (solo si el mensaje ES solo eso)
        const greetingOnly = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|d[ií]as))?)\s*$/i.test(userInput.trim());
        const thanksOnly   = /^\s*(gracias|thank\s*you|ty)\s*$/i.test(userInput.trim());
        
        if (greetingOnly || thanksOnly) {
          let out = thanksOnly
            ? (idiomaDestino === 'es'
                ? '¡De nada! 💬 si necesitas algo mas dejame saber'
                : "You're welcome! 💬 If you need anything else, let me know.")
            : bienvenida;

          try {
            const langOut = await detectarIdioma(out);
            if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
              out = await traducirMensaje(out, idiomaDestino);
            }
          } catch {}
          await sendMetaContabilizando(out);

          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          continue;
        }

        // 🔎 Intención antes del EARLY RETURN (no directas)
        const { intencion: intenTemp } = await detectarIntencion(userInput, tenantId, canalContenido as any);
        const intenCanon = normalizeIntentAlias((intenTemp || '').toLowerCase());
        const esDirecta  = INTENTS_DIRECT.has(intenCanon);

        if (!esDirecta) {
          console.log('🛣️ [META] EARLY_RETURN con promptBase (no directa). Intención =', intenCanon);

          try {
            const fallbackBienvenida =
              (tenant.bienvenida_meta && String(tenant.bienvenida_meta).trim())
              || getBienvenidaPorCanal('meta', tenant, idiomaDestino);

            const systemPrompt = [
              promptBase,
              '',
              `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
              'Formato Meta: máx. ~6 líneas en PROSA. Sin Markdown, sin bullets.',
              'Usa únicamente los HECHOS; no inventes.',
              'Si hay ENLACES_OFICIALES en los hechos/prompt, comparte solo 1 (el más pertinente) tal cual.'
            ].join('\n');

            const userPrompt = [
              `MENSAJE_USUARIO:\n${userInput}`,
              '',
              'Responde usando solo los datos del prompt del negocio.'
            ].join('\n');

            let out = fallbackBienvenida;

            try {
              const completion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                temperature: 0.2,
                max_tokens: 400,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user',   content: userPrompt },
                ],
              });

              const used = completion.usage?.total_tokens || 0;
              if (used > 0) {
                await pool.query(
                  `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                   VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                   ON CONFLICT (tenant_id, canal, mes)
                   DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                  [tenantId, used]
                );
              }

              out = completion.choices[0]?.message?.content?.trim() || fallbackBienvenida;
            } catch (e) {
              console.warn('⚠️ [META] EARLY_RETURN LLM falló, usando bienvenida como fallback:', e);
            }

            // Asegurar idioma correcto
            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}

            // CTA por intención (usando helpers de arriba)
            const intentForCTA = pickIntentForCTA({
              fallback: intenCanon || null,
            });

            const ctaXraw = await pickCTA(tenant, intentForCTA, canalEnvio);
            const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);

            // ❌ NO CTA si era puro saludo / cortesía
            const outWithCTA = isSmallTalkOrCourtesy
              ? out
              : appendCTAWithCap(out, ctaX);

            // 1) Enviar a Meta contabilizando uso
            await sendMetaContabilizando(outWithCTA);

            // 2) Guardar mensaje del bot
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
               VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
               ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenantId, outWithCTA, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
            );

            // 3) Registrar interacción
            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT DO NOTHING`,
              [tenantId, canalEnvio, messageId]
            );

            // 4) Follow-up usando la intención canónica
            try {
              const det = await detectarIntencion(userInput, tenantId, canalContenido as any);
              const nivel = det?.nivel_interes ?? 1;
              await scheduleFollowUp(intenCanon || 'duda', nivel);
            } catch (e) {
              console.warn('⚠️ [META] No se pudo programar follow-up en EARLY_RETURN:', e);
            }

            // ✅ EARLY RETURN: ya respondimos este mensaje
            continue;
          } catch (e) {
            console.warn('❌ [META] EARLY_RETURN helper falló; sigo pipeline FAQ/intents:', e);
            // No hacemos continue; dejamos que siga al matcher/FAQ
          }
        } else {
          console.log('🛣️ [META] Ruta: FAQ/Intents (intención directa). Intención =', intenCanon);
        }

        // Cargar FAQs del canal meta
        let faqs: any[] = [];
        try {
          const resFaqs = await pool.query(
            `SELECT pregunta, respuesta
               FROM faqs
              WHERE tenant_id = $1
                AND canal = ANY($2::text[])`,
            [tenantId, ['meta','facebook','instagram']]
          );
          faqs = resFaqs.rows || [];
        } catch {}
    
        // INTENT MATCHER (con guards)
        try {
          const idiomaDet: 'es'|'en' = normalizeLang(normLang(await detectarIdioma(userInput)) || tenantBase);
          const textoParaMatch = (idiomaDet === 'es') ? userInput : await traducirMensaje(userInput, 'es');

          const respIntent = await buscarRespuestaPorIntencion({
            tenant_id: tenantId,
            canal: 'meta',
            mensajeUsuario: textoParaMatch,
            idiomaDetectado: idiomaDet,
            umbral: Math.max(INTENT_THRESHOLD, 0.70),
            filtrarPorIdioma: true
          });

          // Canonical detect (rápido) para aplicar guards
          const { intencion: intenTemp } = await detectarIntencion(userInput, tenantId, canalEnvio);
          const canonical = normalizeIntentAlias((intenTemp || '').toLowerCase());
          const isCanonicalDirect = isDirectIntent(canonical, INTENTS_DIRECT);
          const respIntentName = (respIntent?.intent || '').toLowerCase();
          const askedPrice = PRICE_REGEX.test(userInput);

          // Guard 1: no “precio” si no lo pidió y la canónica difiere
          if (respIntent && respIntentName === 'precio' && !askedPrice && canonical && canonical !== 'precio') {
            // @ts-ignore
            respIntent.intent = null;
            // @ts-ignore
            respIntent.respuesta = null;
          }
          // Guard 2: si canónica es DIRECTA y difiere, exige score alto
          if (respIntent && isCanonicalDirect && respIntentName && respIntentName !== canonical) {
            const score = Number(respIntent?.score ?? 0);
            if (score < MATCHER_MIN_OVERRIDE) {
              // @ts-ignore
              respIntent.intent = null;
              // @ts-ignore
              respIntent.respuesta = null;
            }
          }

          if (respIntent?.respuesta) {
            // Pasar por LLM con promptBase (igual WA)
            const systemPrompt = [
              promptBase,
              '',
              `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
              'Formato Meta: máx. ~6 líneas en PROSA. Sin Markdown, sin bullets.',
              'Usa únicamente los HECHOS; no inventes.',
              'Si hay ENLACES_OFICIALES en los hechos/prompt, comparte solo 1 (el más pertinente) tal cual.'
            ].join('\n');

            let facts = respIntent.respuesta;
            const askedInfo = /\b(info(?:rmación)?|clases?|servicios?)\b/i.test(userInput);
            if (askedInfo && askedPrice) {
              try {
                const { rows } = await pool.query(
                  `SELECT respuesta FROM faqs
                    WHERE tenant_id = $1
                      AND canal = ANY($2::text[])
                      AND LOWER(intencion) IN ('interes_clases','info_general','servicios')
                    ORDER BY 1 LIMIT 1`,
                  [tenantId, ['meta','facebook','instagram']]
                );
                const extra = rows[0]?.respuesta?.trim();
                if (extra) facts = `${extra}\n\n${facts}`;
              } catch {}
            }

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
              const used = completion.usage?.total_tokens || 0;
              if (used > 0) {
                await pool.query(
                  `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                   VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                   ON CONFLICT (tenant_id, canal, mes)
                   DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                  [tenantId, used]
                );
              }
              out = completion.choices[0]?.message?.content?.trim() || out;
            } catch (e) {
              console.warn('LLM compose falló; uso facts crudos:', e);
            }

            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}

            await sendMetaContabilizando(out);
            await pool.query(
              `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
               VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
               ON CONFLICT (tenant_id, message_id) DO NOTHING`,
              [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
            );
            await pool.query(
              `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT DO NOTHING`,
              [tenantId, canalEnvio, messageId]
            );

            try {
              const det = await detectarIntencion(userInput, tenantId, canalEnvio);
              const nivel = det?.nivel_interes ?? 1;
              let intFinal = (respIntent.intent || '').toLowerCase().trim();
              if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
              intFinal = normalizeIntentAlias(intFinal);
              await scheduleFollowUp(intFinal, nivel);
            } catch {}

            continue; // ✅ ya respondió por intención
          }
        } catch (e) {
          console.warn('⚠️ Matcher de intenciones no coincidió o falló:', e);
        }

        // Interceptor de principiantes (canal-agnóstico)
        let intencionParaFaq = '';
        try {
          const textoES = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
          const det0 = await detectarIntencion(textoES, tenantId, canalEnvio);
          let proc = (det0?.intencion || '').trim().toLowerCase();
          if (proc === 'duda') proc = buildDudaSlug(userInput);
          proc = normalizeIntentAlias(proc);

          if (PRICE_REGEX.test(userInput)) proc = 'precio';
          else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) proc = 'clases_online';

          intencionParaFaq = proc;
        } catch {}

        const interceptado = await runBeginnerRecoInterceptor({
          tenantId,
          canal: canalEnvio,
          fromNumber: senderId,
          userInput,
          idiomaDestino,
          intencionParaFaq,
          promptBase,
          enviarFn: enviarMetaSeguro,
        });

        if (interceptado) {
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
          // follow-up post interceptor (opcional)
          try {
            const det = await detectarIntencion(userInput, tenantId, canalEnvio);
            await scheduleFollowUp(intencionParaFaq || normalizeIntentAlias(det?.intencion || ''), det?.nivel_interes ?? 1);
          } catch {}
          continue;
        }

        // FAQ directa por intención (global, igual a WA)
        try {
          let intentFAQ = (intencionParaFaq || '').trim().toLowerCase();
          if (!intentFAQ) {
            const textoES = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
            const det1 = await detectarIntencion(textoES, tenantId, canalEnvio);
            let proc = (det1?.intencion || '').trim().toLowerCase();
            if (proc === 'duda') proc = buildDudaSlug(userInput);
            proc = normalizeIntentAlias(proc);
            if (PRICE_REGEX.test(userInput)) proc = 'precio';
            else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) proc = 'clases_online';
            intentFAQ = proc;
          }

          if (isDirectIntent(intentFAQ, INTENTS_DIRECT)) {
            let respuestaDesdeFaq: string | null = null;
            if (intentFAQ === 'precio') {
              respuestaDesdeFaq = await fetchFaqPrecio(tenantId, canalContenido);
            } else {
              const hit = await getFaqByIntent(tenantId, canalContenido as any, intentFAQ);
              respuestaDesdeFaq = hit?.respuesta || null;
            }

            if (respuestaDesdeFaq) {
              // Pasar por LLM con promptBase (igual WA/intent branch de arriba)
              const systemPrompt = [
                promptBase,
                '',
                `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
                'Formato Meta: máx. ~6 líneas, claro, sin bullets.',
                'Usa SOLO la información del prompt/HECHOS.',
                'Si hay ENLACES_OFICIALES, comparte solo 1 (el más pertinente).'
              ].join('\n');

              const userPrompt = [
                `MENSAJE_USUARIO:\n${userInput}`,
                '',
                `HECHOS (fuente autorizada):\n${respuestaDesdeFaq}`
              ].join('\n');

              let out = respuestaDesdeFaq;
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
                const used = completion.usage?.total_tokens || 0;
                if (used > 0) {
                  await pool.query(
                    `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                     VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                     ON CONFLICT (tenant_id, canal, mes)
                     DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                    [tenantId, used]
                  );
                }
                out = completion.choices[0]?.message?.content?.trim() || out;
              } catch (e) {
                console.warn('LLM compose (FAQ) falló; envío facts crudos:', e);
              }

              try {
                const langOut = await detectarIdioma(out);
                if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                  out = await traducirMensaje(out, idiomaDestino);
                }
              } catch {}

              await sendMetaContabilizando(out);
              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
                 VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
                 ON CONFLICT (tenant_id, message_id) DO NOTHING`,
                [tenantId, out, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
              );
              await pool.query(
                `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT DO NOTHING`,
                [tenantId, canalEnvio, messageId]
              );

              // follow-up si aplica
              try {
                const det = await detectarIntencion(userInput, tenantId, canalEnvio);
                const nivel = det?.nivel_interes ?? 1;
                await scheduleFollowUp(intentFAQ, nivel);
              } catch {}

              continue; // ⛔️ no sigas a similitud/LLM genérico
            }
          }
        } catch (e) {
          console.warn('⚠️ FAQ directa global falló:', e);
        }

        // —————————————————————————
        // Similaridad + LLM fallback (sugeridas)
        // —————————————————————————
        let respuesta = '';

        // Similaridad sobre FAQs traducidas (reutiliza helper existente si lo prefieres)
        // Aquí haremos un fallback directo a LLM con promptBase si no hubo nada antes:
        if (!respuesta) {
          try {
            const systemPrompt = [
              promptBase,
              '',
              `Reglas:
              - Usa EXCLUSIVAMENTE la info del prompt. Si falta algo, dilo sin inventar.
              - Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.
              - Meta: máx. ~6 líneas en PROSA. Sin Markdown/viñetas.
              - Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.
              - CTA único (si aplica). Enlaces: solo si están en ENLACES_OFICIALES.`
            ].join('\n');

            const userPrompt = `MENSAJE_USUARIO:\n${userInput}\n\nResponde usando solo los datos del prompt.`;

            const completion = await openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 400,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
              ],
            });

            const used = completion.usage?.total_tokens ?? 0;
            if (used > 0) {
              await pool.query(
                `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
                 VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
                 ON CONFLICT (tenant_id, canal, mes)
                 DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
                [tenantId, used]
              );
            }

            respuesta = completion.choices[0]?.message?.content?.trim()
                      || bienvenida;

            // Asegura idioma
            try {
              const langOut = await detectarIdioma(respuesta);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                respuesta = await traducirMensaje(respuesta, idiomaDestino);
              }
            } catch {}

            // Registrar FAQ sugerida (con reglas de unicidad como WA)
            const hasLetters = /\p{L}/u.test(userInput);
            if (hasLetters && normalizarTexto(userInput).length >= 4) {
              const preguntaNormalizada = normalizarTexto(userInput);
              const respuestaNormalizada = (respuesta || '').trim();

              let sugeridasExistentes: any[] = [];
              try {
                const sugRes = await pool.query(
                  'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
                  [tenantId, canalContenido]
                );
                sugeridasExistentes = sugRes.rows || [];
              } catch {}

              const yaExisteSug = yaExisteComoFaqSugerida(userInput, respuesta || '', sugeridasExistentes);
              const yaExisteAprob = yaExisteComoFaqAprobada(userInput, respuesta || '', faqs);

              if (!yaExisteSug && !yaExisteAprob) {
                const textoESparaGuardar = (idiomaDestino === 'es') ? userInput : await traducirMensaje(userInput, 'es');
                const detGuardar = await detectarIntencion(textoESparaGuardar, tenantId, canalEnvio);
                let intencionFinal = (detGuardar?.intencion || '').trim().toLowerCase();
                if (intencionFinal === 'duda') intencionFinal = buildDudaSlug(userInput);
                intencionFinal = normalizeIntentAlias(intencionFinal);

                if (PRICE_REGEX.test(userInput)) intencionFinal = 'precio';
                else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) intencionFinal = 'clases_online';

                if (INTENT_UNIQUE.has(intencionFinal)) {
                  const { rows: faqsOficiales } = await pool.query(
                    `SELECT 1
                       FROM faqs
                      WHERE tenant_id = $1
                        AND canal = ANY($2::text[])
                        AND LOWER(intencion) = LOWER($3)
                      LIMIT 1`,
                    [tenantId, ['meta','facebook','instagram'], intencionFinal]
                  );
                  if (!faqsOficiales.length) {
                    const { rows: sugConInt } = await pool.query(
                      `SELECT 1 FROM faq_sugeridas
                        WHERE tenant_id = $1 AND canal = $2 AND procesada = false
                          AND LOWER(intencion) = LOWER($3)
                        LIMIT 1`,
                      [tenantId, canalContenido, intencionFinal]
                    );
                    if (!sugConInt.length) {
                      await pool.query(
                        `INSERT INTO faq_sugeridas
                          (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                        VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                        [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDestino, intencionFinal]
                      );
                    }
                  }
                } else {
                  await pool.query(
                    `INSERT INTO faq_sugeridas
                      (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
                    VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
                    [tenantId, canalContenido, preguntaNormalizada, respuestaNormalizada, idiomaDestino, intencionFinal]
                  );
                }
              } else if (yaExisteSug) {
                await pool.query(
                  `UPDATE faq_sugeridas
                     SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
                   WHERE id = $1`,
                  [yaExisteSug.id]
                );
              }
            }
          } catch (e) {
            console.warn('❌ EARLY_RETURN Meta falló:', e);
          }
        }

        // Enviar salida final si llegamos aquí
        const outFinal = respuesta || bienvenida;
        try {
          await sendMetaContabilizando(outFinal);
          await pool.query(
            `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
             VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
             ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, outFinal, canalEnvio, senderId || 'anónimo', `${messageId}-bot`]
          );
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [tenantId, canalEnvio, messageId]
          );
        } catch (err: any) {
          console.error('❌ Error enviando a Meta:', err?.response?.data || err.message || err);
        }

        // Inteligencia de ventas + follow-up final (idéntico a WA)
        try {
          const det = await detectarIntencion(userInput, tenantId, canalEnvio);
          const nivel_interes = det?.nivel_interes ?? 1;
          let intFinal = normalizeIntentAlias((det?.intencion || '').toLowerCase());

          if (intFinal === 'duda') intFinal = buildDudaSlug(userInput);
          if (PRICE_REGEX.test(userInput)) intFinal = 'precio';
          else if (/\b(?:online|en\s*linea|virtual(?:es|idad)?)\b/i.test(userInput)) intFinal = 'clases_online';

          // Segmentación básica
          const intencionesCliente = ["comprar","compra","pagar","agendar","reservar","confirmar","interes_clases","precio"];
          if (intencionesCliente.some(p => intFinal.includes(p))) {
            await pool.query(
              `UPDATE clientes
                  SET segmento = 'cliente'
               WHERE tenant_id = $1 AND contacto = $2
                 AND (segmento = 'lead' OR segmento IS NULL)`,
              [tenantId, senderId]
            );
          }

          await scheduleFollowUp(intFinal, nivel_interes);
        } catch (e) {
          console.warn('⚠️ Error en inteligencia de ventas o seguimiento:', e);
        }
      }
    }
  } catch (error: any) {
    console.error('❌ Error en webhook Meta:', error?.response?.data || error.message || error);
  }
});

export default router;
